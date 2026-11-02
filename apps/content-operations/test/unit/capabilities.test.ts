import { describe, expect, it, vi } from "vitest";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { DynamoDbWorkerIdempotencyStore, SqsWorkerAdapter } from "@jawstack/aws-runtime";
import type { JawStackEvent } from "@jawstack/core";
import { createLabConfig, localQueueUrl } from "../../src/lab/config";
import type { LabClients } from "../../src/lab/clients";
import { putProofArtifact } from "../../src/lab/artifact";
import { collectFailure, handleProofFact } from "../../src/lab/handlers";
import { functionArn, schedulerRoleArn, setSchedule } from "../../src/lab/capabilities";
import { verifyCapabilities } from "../../src/lab/verify-capabilities";

const config = createLabConfig();
const fact: JawStackEvent = {
  envelopeVersion: 1,
  eventId: "evt_failure",
  eventType: "spineProof.created",
  schemaVersion: 1,
  source: config.source,
  resourceType: "spineProof",
  resourceId: "proof_failure",
  correlationId: "correlation",
  occurredAt: "2026-10-31T12:00:00.000Z",
  payload: { message: "Injected failure", fail: true },
};

function objectStore() {
  const objects = new Map<string, { body: string; metadata: Record<string, string> }>();
  const send = vi.fn(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const key = command.input.Key as string;
      if (command.constructor.name === "PutObjectCommand") {
        expect(command.input.IfNoneMatch).toBe("*");
        if (objects.has(key)) throw Object.assign(new Error(), { name: "PreconditionFailed" });
        objects.set(key, {
          body: command.input.Body as string,
          metadata: command.input.Metadata as Record<string, string>,
        });
        return {};
      }
      if (command.constructor.name === "GetObjectCommand") {
        const value = objects.get(key)!;
        return {
          ContentLength: value.body.length,
          Metadata: value.metadata,
          Body: { transformToString: async () => value.body },
        };
      }
      if (command.constructor.name === "GetPublicAccessBlockCommand")
        return {
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        };
      if (command.constructor.name === "GetBucketOwnershipControlsCommand")
        return { OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] } };
      if (command.constructor.name === "ListObjectsV2Command")
        return {
          Contents: [...objects.keys()]
            .filter((name) => name.startsWith(String(command.input.Prefix ?? "")))
            .map((Key) => ({ Key })),
        };
      throw new Error("Unexpected object command");
    },
  );
  return { objects, send, clients: { s3: { send } } as unknown as Pick<LabClients, "s3"> };
}

function records(failWrites = false) {
  const rows = new Map<string, Record<string, unknown>>();
  const send = vi.fn(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "GetItemCommand") {
        const key = unmarshall(command.input.Key as Parameters<typeof unmarshall>[0]);
        const item = rows.get(`${key.PK}/${key.SK}`);
        return item ? { Item: marshall(item) } : {};
      }
      if (command.constructor.name === "PutItemCommand") {
        const item = unmarshall(command.input.Item as Parameters<typeof unmarshall>[0]);
        if (failWrites && String(item.PK).startsWith("DLQ#"))
          throw new Error("Durable store unavailable");
        const key = `${item.PK}/${item.SK}`;
        if (rows.has(key))
          throw Object.assign(new Error(), { name: "ConditionalCheckFailedException" });
        rows.set(key, item);
        return {};
      }
      throw new Error("Unexpected record command");
    },
  );
  return { rows, send, clients: { dynamo: { send } } as unknown as Pick<LabClients, "dynamo"> };
}

describe("feasibility capabilities", () => {
  it("converges concurrent conditional writes and refuses a different body", async () => {
    const store = objectStore();
    const results = await Promise.all([
      putProofArtifact(store.clients, config, "proofs/test.json", "body"),
      putProofArtifact(store.clients, config, "proofs/test.json", "body"),
    ]);
    expect(results.map((r) => r.created).sort()).toEqual([false, true]);
    expect(store.objects.size).toBe(1);
    await expect(
      putProofArtifact(store.clients, config, "proofs/test.json", "changed"),
    ).rejects.toThrow("mismatch");
    expect(store.objects.get("proofs/test.json")?.body).toBe("body");
  });

  it("does not turn access/transport errors into duplicate success", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("denied"), { name: "AccessDenied" });
    });
    const c = { s3: { send } } as unknown as Pick<LabClients, "s3">;
    await expect(putProofArtifact(c, config, "proofs/test.json", "body")).rejects.toThrow("denied");
    expect(send).toHaveBeenCalledTimes(1);
    await expect(putProofArtifact(c, config, "../escape", "body")).rejects.toThrow(
      "Invalid proof artifact",
    );
    await expect(putProofArtifact(c, config, "proofs/test.json", "x".repeat(1025))).rejects.toThrow(
      "Invalid proof artifact",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("records each failed receive and never creates an artifact or success receipt", async () => {
    const db = records();
    const store = objectStore();
    const clients = { ...db.clients, ...store.clients };
    for (let count = 1; count <= 3; count++)
      await expect(handleProofFact(clients, config, fact, count)).rejects.toThrow(
        "Injected proof failure",
      );
    expect([...db.rows.values()].map((row) => row.receiveCount)).toEqual([1, 2, 3]);
    expect(store.send).not.toHaveBeenCalled();
    expect([...db.rows.values()].every((row) => String(row.PK).startsWith("ATTEMPT#"))).toBe(true);
  });

  it("does not acknowledge or mark a collected message until the failure is durable", async () => {
    const db = records(true);
    const adapter = new SqsWorkerAdapter({
      workerName: "collector",
      idempotencyStore: new DynamoDbWorkerIdempotencyStore({
        client: db.clients.dynamo,
        tableName: config.table,
      }),
      handler: ({ event }) => collectFailure(db.clients, config, event),
    });
    await expect(
      adapter.handle({ Records: [{ messageId: "m1", body: JSON.stringify(fact) }] }),
    ).rejects.toThrow("Durable store unavailable");
    expect(db.rows.size).toBe(0);
  });

  it("commits failure before processed marker and deduplicates repeat collection", async () => {
    const db = records();
    const adapter = new SqsWorkerAdapter({
      workerName: "collector",
      idempotencyStore: new DynamoDbWorkerIdempotencyStore({
        client: db.clients.dynamo,
        tableName: config.table,
      }),
      handler: ({ event }) => collectFailure(db.clients, config, event),
    });
    const event = { Records: [{ messageId: "m1", body: JSON.stringify(fact) }] };
    await adapter.handle(event);
    await adapter.handle(event);
    expect([...db.rows.values()].map((row) => String(row.PK).split("#")[0])).toEqual([
      "DLQ",
      "WORKER",
    ]);
    expect(db.rows.get(`DLQ#${fact.resourceId}/FAILURE`)?.originalEvent).toEqual(fact);
  });

  it("rejects incorrect fact source and ordinary successful events in the collector", async () => {
    const db = records();
    await expect(
      collectFailure(db.clients, config, { ...fact, source: "foreign" }),
    ).rejects.toThrow("Unexpected");
    await expect(
      collectFailure(db.clients, config, { ...fact, payload: { message: "success" } }),
    ).rejects.toThrow("injected");
    expect(db.send).not.toHaveBeenCalled();
  });

  it("validates both local queue names without accepting other origins or queues", () => {
    expect(
      localQueueUrl(`http://localstack:4566/000000000000/${config.dlq}`, config, config.dlq),
    ).toContain(config.dlq);
    expect(() =>
      localQueueUrl(`http://localstack:4566/000000000000/foreign`, config, "foreign"),
    ).toThrow();
    expect(() =>
      localQueueUrl(
        `https://sqs.us-east-1.amazonaws.com/000000000000/${config.dlq}`,
        config,
        config.dlq,
      ),
    ).toThrow();
  });

  it("does not enable an unexpected scheduler target", async () => {
    const send = vi.fn(async () => ({ Target: { Arn: "foreign", RoleArn: "foreign" } }));
    await expect(
      setSchedule({ scheduler: { send } } as unknown as LabClients, config, "run", true),
    ).rejects.toThrow("Unexpected scheduler target");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("attempts disable even when schedule enable reports a lost response", async () => {
    const store = objectStore();
    const states: unknown[] = [];
    const send = vi.fn(
      async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.constructor.name === "GetScheduleCommand")
          return {
            Target: {
              Arn: functionArn(config, config.scheduled),
              RoleArn: schedulerRoleArn(config),
            },
          };
        if (command.constructor.name === "UpdateScheduleCommand") {
          states.push(command.input.State);
          if (command.input.State === "ENABLED") throw new Error("Enable response lost");
          return {};
        }
        throw new Error("Unexpected scheduler operation");
      },
    );
    const c = { ...store.clients, scheduler: { send } } as unknown as LabClients;
    await expect(verifyCapabilities(c, config)).rejects.toThrow("Enable response lost");
    expect(states).toEqual(["ENABLED", "DISABLED"]);
  });
});
