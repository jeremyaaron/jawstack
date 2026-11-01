import { describe, expect, it, vi } from "vitest";
import { createInMemoryPersistence, executeCommand, TestAuthProvider } from "@jawstack/core";
import { buildCommandTransactWriteItems } from "@jawstack/aws-runtime";
import { proofResource } from "../../src/lab/resource";
import { createLabConfig, localstackImage, type LabManifest } from "../../src/lab/config";
import type { LabClients } from "../../src/lab/clients";
import { cleanupSpine, missing, provisionSpine, waitFor } from "../../src/lab/provision";

describe("transactional spine harness", () => {
  it("uses real public command contracts and atomically commits every proof record", async () => {
    const memory = createInMemoryPersistence();
    const commit = vi.spyOn(memory.unitOfWork, "commit");
    const options = {
      registry: [proofResource],
      repository: memory.repository,
      unitOfWork: memory.unitOfWork,
      authProvider: new TestAuthProvider({
        subject: "lab_user",
        roles: ["lab"],
        claims: {},
        mode: "test",
      }),
    };
    const request = {
      resourceType: "spineProof",
      resourceId: "proof_1",
      commandName: "create",
      input: { message: "proof" },
      idempotencyKey: "key_1",
      requestContext: {},
    };
    const result = await executeCommand(request, options);
    expect(result.ok).toBe(true);
    expect(await executeCommand(request, options)).toEqual(result);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(memory.store.resources.size).toBe(1);
    expect(memory.store.activity).toHaveLength(1);
    expect(memory.store.outbox).toHaveLength(1);
    expect(memory.store.projections.size).toBe(1);
    expect(memory.store.idempotency.size).toBe(1);
    const transaction = buildCommandTransactWriteItems(commit.mock.calls[0]![0], {
      tableName: "proof",
      idempotency: { commandName: "create", subject: "lab_user" },
    });
    expect(transaction).toHaveLength(5);
    expect(transaction.map((x) => x.Put?.Item?.itemKind)).toEqual([
      { S: "RESOURCE_STATE" },
      { S: "ACTIVITY" },
      { S: "OUTBOX_EVENT" },
      { S: "PROJECTION_ITEM" },
      { S: "IDEMPOTENCY_RECORD" },
    ]);
  });

  it("rejects unauthorized/invalid proof inputs without partial records", async () => {
    const memory = createInMemoryPersistence();
    const options = {
      registry: [proofResource],
      repository: memory.repository,
      unitOfWork: memory.unitOfWork,
      authProvider: new TestAuthProvider({ subject: "other", roles: [], claims: {}, mode: "test" }),
    };
    const result = await executeCommand(
      {
        resourceType: "spineProof",
        commandName: "create",
        input: { message: "proof" },
        requestContext: {},
      },
      options,
    );
    expect(result.ok).toBe(false);
    expect(memory.store.resources.size).toBe(0);
    expect(memory.store.outbox).toHaveLength(0);
  });

  it("cleanup preflights ownership before performing any deletes", async () => {
    const calls: string[] = [];
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      calls.push(command.constructor.name);
      if (command.constructor.name === "GetFunctionCommand")
        return { Tags: { "jawstack:owner": "somebody-else" } };
      return {};
    });
    const clients = { lambda: { send } } as unknown as LabClients;
    const manifest: LabManifest = {
      schemaVersion: 1,
      instanceId: "dev",
      ownerId: "7dc55154-f37c-499a-90a6-841fbc0cbe1c",
      image: localstackImage,
      status: "ready",
      architecture: "arm64",
      mappings: [],
    };
    await expect(cleanupSpine(clients, createLabConfig(), manifest)).rejects.toThrow("not owned");
    expect(calls).toEqual(["GetFunctionCommand"]);
  });

  it("does not swallow transport failures as missing resources", async () => {
    await expect(
      missing(async () => {
        throw Object.assign(new Error(), { name: "ResourceNotFoundException" });
      }),
    ).resolves.toBeUndefined();
    await expect(
      missing(async () => {
        throw new Error("transport failure");
      }),
    ).rejects.toThrow("transport failure");
  });

  it("checks late ownership failures before deleting earlier owned resources", async () => {
    const ownerId = "7dc55154-f37c-499a-90a6-841fbc0cbe1c";
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case "GetFunctionCommand":
          return { Tags: { "jawstack:owner": ownerId } };
        case "ListTagsLogGroupCommand":
          return { tags: { "jawstack:owner": ownerId } };
        case "DescribeTableCommand":
          return { Table: { TableArn: "table-arn" } };
        case "ListTagsOfResourceCommand":
          return { Tags: [{ Key: "jawstack:owner", Value: "foreign" }] };
        default:
          throw new Error("Unexpected SDK call.");
      }
    });
    const clients = { lambda: { send }, logs: { send }, dynamo: { send } } as unknown as LabClients;
    const manifest: LabManifest = {
      schemaVersion: 1,
      instanceId: "dev",
      ownerId,
      image: localstackImage,
      status: "ready",
      architecture: "arm64",
      mappings: [],
    };
    await expect(cleanupSpine(clients, createLabConfig(), manifest)).rejects.toThrow("not owned");
    expect(
      send.mock.calls.every(([command]) => !command.constructor.name.startsWith("Delete")),
    ).toBe(true);
  });

  it("does not adopt an existing queue through idempotent CreateQueue", async () => {
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "GetQueueUrlCommand") return { QueueUrl: "existing" };
      throw Object.assign(new Error(), { name: "ResourceNotFoundException" });
    });
    const clients = Object.fromEntries(
      ["lambda", "logs", "dynamo", "events", "iam", "sqs"].map((name) => [name, { send }]),
    ) as unknown as LabClients;
    const manifest: LabManifest = {
      schemaVersion: 1,
      instanceId: "dev",
      ownerId: "7dc55154-f37c-499a-90a6-841fbc0cbe1c",
      image: localstackImage,
      status: "starting",
      architecture: "arm64",
      mappings: [],
    };
    await expect(
      provisionSpine(clients, createLabConfig(), manifest, async () => undefined),
    ).rejects.toThrow("already exists");
    expect(
      send.mock.calls.every(([command]) => !command.constructor.name.startsWith("Create")),
    ).toBe(true);
    expect(manifest.status).toBe("starting");
  });

  it("refuses unexpected event mappings before any deletion", async () => {
    const ownerId = "7dc55154-f37c-499a-90a6-841fbc0cbe1c";
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case "GetFunctionCommand":
          return { Tags: { "jawstack:owner": ownerId } };
        case "ListTagsLogGroupCommand":
          return { tags: { "jawstack:owner": ownerId } };
        case "ListEventSourceMappingsCommand":
          return {
            EventSourceMappings: [{ UUID: "unexpected", EventSourceArn: "foreign-source" }],
          };
        default:
          throw Object.assign(new Error(), { name: "ResourceNotFoundException" });
      }
    });
    const clients = Object.fromEntries(
      ["lambda", "logs", "dynamo", "events", "iam", "sqs"].map((name) => [name, { send }]),
    ) as unknown as LabClients;
    const manifest: LabManifest = {
      schemaVersion: 1,
      instanceId: "dev",
      ownerId,
      image: localstackImage,
      status: "ready",
      architecture: "arm64",
      mappings: [],
    };
    await expect(cleanupSpine(clients, createLabConfig(), manifest)).rejects.toThrow(
      "Unexpected event source mapping",
    );
    expect(
      send.mock.calls.every(([command]) => !command.constructor.name.startsWith("Delete")),
    ).toBe(true);
  });

  it("bounds polling and succeeds without a fixed readiness sleep", async () => {
    expect(await waitFor("ready", async () => "ready", 1)).toBe("ready");
    await expect(
      waitFor(
        "never",
        async () => undefined,
        0,
        async () => undefined,
      ),
    ).rejects.toThrow("Timed out");
  });
});
