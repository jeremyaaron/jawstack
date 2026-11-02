import { describe, expect, it, vi, afterEach } from "vitest";
import { createContentJsonLambdaHandler } from "../../src/aws/synth/api";
import { synthesisContext } from "../../src/aws/synth/context";
import { createMemoryApiRuntime } from "../../src/application/api-runtime";
import { createContentOperationsResources } from "../../src/domain/resources";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { TransactionClient, itemKey } from "../support/transaction-client";

const environment = {
  CONTENT_OPS_LAB_ID: "dev",
  CONTENT_OPS_STAGE: "local",
  JAWSTACK_STAGE: "local",
  CONTENT_OPS_RUNTIME: "localstack",
  CONTENT_OPS_SYNTH_ONLY: "true",
  JAWSTACK_AUTH_MODE: "dev",
  JAWSTACK_AUTH_PROVIDER: "fixtures",
  AWS_REGION: "us-east-1",
  AWS_LAMBDA_FUNCTION_NAME: "content-operations-local-api",
  LOCALSTACK_HOSTNAME: "172.21.0.2",
  AWS_ENDPOINT_URL: "http://172.21.0.2:4566",
  JAWSTACK_TABLE_NAME: "content-operations-local-resources",
  JAWSTACK_EVENT_BUS_NAME: "content-operations-local-events",
  CONTENT_OPS_BUCKET_NAME: "jawstack-content-ops-dev-artifacts",
  CONTENT_OPS_EVENT_SOURCE: "content-operations.dev",
};
afterEach(() => vi.unstubAllEnvs());
function harness() {
  for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value);
  const runtime = createMemoryApiRuntime();
  const factory = vi.fn(() => runtime);
  const handler = createContentJsonLambdaHandler(factory);
  const event = (path: string, input?: unknown, fixture: string | undefined = "author_1") => {
    const [rawPath, rawQueryString = ""] = path.split("?");
    return {
      version: "2.0",
      rawPath: rawPath!,
      rawQueryString,
      requestContext: { http: { method: input === undefined ? "GET" : "POST" } },
      headers: {
        ...(fixture ? { "x-content-ops-fixture": fixture } : {}),
        "content-type": "application/json",
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      isBase64Encoded: false,
    };
  };
  const call = async (path: string, input?: unknown, fixture?: string) => {
    const result = await handler(event(path, input, fixture));
    const body = JSON.parse(result.body) as {
      ok: boolean;
      data: Record<string, unknown>;
      error: { code: string; message: string; details?: unknown };
      meta: { requestId: string; correlationId: string };
    };
    return { ...result, body };
  };
  return { runtime, factory, handler, event, call };
}
describe("synthesis-only JSON ingress", () => {
  it("binds the default API and worker entrypoints to the synthesized table and real shared handlers", async () => {
    const h = harness();
    class MarkerClient extends TransactionClient {
      override async send(command: { input: unknown }) {
        if (!(command instanceof PutItemCommand)) return super.send(command);
        const key = itemKey(command.input.Item!);
        if (this.items.has(key))
          throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
        this.items.set(key, structuredClone(command.input.Item!));
        return {};
      }
    }
    const client = new MarkerClient();
    const network = vi.spyOn(NodeHttpHandler.prototype, "handle");
    const sdk = vi
      .spyOn(DynamoDBClient.prototype, "send")
      .mockImplementation(
        async (command: unknown) => (await client.send(command as { input: unknown })) as never,
      );
    try {
      const api = createContentJsonLambdaHandler();
      const created = JSON.parse(
        (
          await api(
            h.event("/api/resources/contentItem/commands/create", {
              input: {
                title: "Bound runtime",
                body: "SDK contract evidence, not a cloud deployment.",
              },
              idempotencyKey: "bound-create",
            }),
          )
        ).body,
      ) as { data: { resourceId: string } };
      const submitted = await api(
        h.event(`/api/resources/contentItem/${created.data.resourceId}/commands/submit`, {
          input: {
            expectedVersion: 1,
            assignedEditorId: "editor_1",
            dueAt: new Date(Date.now() + 86400000).toISOString(),
          },
          idempotencyKey: "bound-submit",
        }),
      );
      expect(submitted.statusCode).toBe(200);
      const source = [...client.items.values()]
        .map((item) => unmarshall(item))
        .find(
          (item) =>
            item.itemKind === "OUTBOX_EVENT" &&
            (item.event as { eventType: string }).eventType === "contentItem.reviewRequested",
        )!.event;
      const { worker } = await import("../../src/aws/synth/entrypoints");
      for (const consumer of ["materializeReview", "deliverNotification"]) {
        const queueArn = `arn:aws:sqs:us-east-1:000000000000:content-operations-local-${consumer.toLowerCase()}-queue`;
        vi.stubEnv(
          "AWS_LAMBDA_FUNCTION_NAME",
          `content-operations-local-${consumer.toLowerCase()}-worker`,
        );
        vi.stubEnv("CONTENT_OPS_CONSUMER", consumer);
        vi.stubEnv("CONTENT_OPS_QUEUE_ARN", queueArn);
        const batch = {
          Records: [
            {
              messageId: "bound-event",
              eventSource: "aws:sqs",
              awsRegion: "us-east-1",
              eventSourceARN: queueArn,
              body: JSON.stringify(source),
            },
          ],
        };
        expect(await worker(batch)).toMatchObject({ processed: 1 });
        expect(await worker(batch)).toMatchObject({ skipped: 1 });
      }
      const items = [...client.items.values()].map((item) => unmarshall(item));
      expect(
        items.filter(
          (item) => item.itemKind === "RESOURCE_STATE" && item.resourceType === "reviewTask",
        ),
      ).toHaveLength(1);
      expect(items.filter((item) => item.itemKind === "APP_NOTIFICATION")).toHaveLength(1);
      expect(
        client.transactions.every((transaction) =>
          transaction.TransactItems!.every(
            (write) =>
              write.Put?.TableName === environment.JAWSTACK_TABLE_NAME ||
              write.Delete?.TableName === environment.JAWSTACK_TABLE_NAME,
          ),
        ),
      ).toBe(true);
      expect(network).not.toHaveBeenCalled();
    } finally {
      sdk.mockRestore();
      network.mockRestore();
    }
  });
  it("shares real scoped commands, queries, resource/activity reads and fixture policy", async () => {
    const h = harness();
    const dispatch = vi.spyOn(h.runtime, "dispatch");
    const created = await h.call("/api/resources/contentItem/commands/create", {
      input: { title: "Synth routing", body: "Actual application command." },
      idempotencyKey: "synth-create",
    });
    expect(created.statusCode).toBe(200);
    expect(dispatch.mock.calls[0]?.[1].mode).toBe("dev");
    const id = created.body.data.resourceId as string;
    const listed = await h.call("/api/content?limit=10");
    expect(listed.body.data.items).toHaveLength(1);
    expect((await h.call(`/api/resources/contentItem/${id}`)).body.data.resource).toMatchObject({
      resourceId: id,
      version: 1,
    });
    expect(
      (await h.call(`/api/resources/contentItem/${id}/activity`)).body.data.items,
    ).toHaveLength(1);
    expect(
      (
        await h.call(
          `/api/resources/contentItem/${id}/commands/editDraft`,
          {
            input: { expectedVersion: 1, title: "Stolen", body: "Other author" },
            idempotencyKey: "steal",
          },
          "author_2",
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.call(`/api/resources/contentItem/${id}/commands/editDraft`, {
          input: { expectedVersion: 7, title: "Stale", body: "Body" },
          idempotencyKey: "stale",
        })
      ).body.error,
    ).toMatchObject({
      code: "resource.conflict",
      details: { expectedVersion: 7, actualVersion: 1 },
    });
    expect(
      (
        await h.call(
          `/api/resources/contentItem/${id}/commands/completeUpload`,
          { input: {}, idempotencyKey: "internal" },
          "editor_1",
        )
      ).statusCode,
    ).toBe(403);
    expect((await h.call("/api/operations?view=notifications")).statusCode).toBe(403);
    expect(
      (await h.call("/api/operations?view=notifications", undefined, "editor_1")).statusCode,
    ).toBe(200);
    expect(
      createContentOperationsResources().every((resource) => resource.schedules.length === 0),
    ).toBe(true);
  });
  it("retains original metadata on an ambiguous command replay", async () => {
    const h = harness();
    const event = h.event("/api/resources/contentItem/commands/create", {
      input: { title: "Replay", body: "Body" },
      idempotencyKey: "stable-intent",
    });
    const first = await h.handler({
      ...event,
      headers: {
        ...event.headers,
        "x-request-id": "original-request",
        "x-correlation-id": "original-correlation",
      },
    });
    const again = await h.handler({
      ...event,
      headers: {
        ...event.headers,
        "x-request-id": "retry-request",
        "x-correlation-id": "retry-correlation",
      },
    });
    expect(JSON.parse(again.body)).toEqual(JSON.parse(first.body));
    expect(again.headers["x-request-id"]).toBe("original-request");
    expect(again.headers["x-correlation-id"]).toBe("original-correlation");
    expect(h.runtime.app.persistence.store.resources.size).toBe(1);
  });
  it("serves dev-only metadata without creating runtime clients and hides internal commands", async () => {
    const h = harness();
    const result = await h.call("/api/manifest");
    expect(result.body.data.auth).toMatchObject({ mode: "dev", provider: "fixtures" });
    expect(result.body.data.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "reviewTask", commands: [], workers: [], schedules: [] }),
      ]),
    );
    expect(JSON.stringify(result.body.data)).not.toContain('"completeUpload"');
    expect(h.factory).not.toHaveBeenCalled();
    expect((await h.call("/api/health")).body.data.status).toBe("synthesis-only");
    expect((await h.call("/api/fixtures")).statusCode).toBe(200);
  });
  it("matches query errors and sanitizes unknown runtime failures", async () => {
    const h = harness();
    expect((await h.call("/api/content?limit=oops")).body.error.code).toBe("query.invalid");
    expect((await h.call("/api/content?limit=1&limit=2")).statusCode).toBe(400);
    h.factory.mockImplementationOnce(() => {
      throw new Error("private-sdk-endpoint-secret");
    });
    const result = await h.call("/api/content");
    expect(result.statusCode).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain("private-sdk-endpoint-secret");
    const missing = await h.handler(h.event("/api/content", undefined, ""));
    expect(missing.statusCode).toBe(401);
    expect((await h.call("/api/content", undefined, "upload_verifier")).statusCode).toBe(403);
  });
  it("rejects oversized/binary/malformed transports and unsupported host-only routes", async () => {
    const h = harness();
    const base = h.event("/api/content");
    expect((await h.handler({ ...base, body: "x".repeat(256 * 1024 + 1) })).statusCode).toBe(413);
    expect((await h.handler({ ...base, isBase64Encoded: true })).statusCode).toBe(415);
    expect((await h.handler({ ...base, body: "{}" })).statusCode).toBe(400);
    expect((await h.handler({ ...base, rawPath: "//evil.example/api/content" })).statusCode).toBe(
      400,
    );
    expect(
      (await h.handler({ ...base, rawPath: "/api/resources/contentItem/bad%2Fid" })).statusCode,
    ).toBe(400);
    expect(
      (
        await h.handler({
          ...base,
          headers: { "x-content-ops-fixture": "author_1", "X-Content-Ops-Fixture": "author_2" },
        })
      ).statusCode,
    ).toBe(400);
    expect((await h.call("/api/development/seed", { confirm: true }, "editor_1")).statusCode).toBe(
      404,
    );
    expect(
      (await h.call("/api/assets/10000000-0000-4000-8000-000000000001/download")).statusCode,
    ).toBe(404);
    const created = h.event("/api/resources/contentItem/commands/create", {});
    expect((await h.handler({ ...created, body: "{" })).statusCode).toBe(400);
    expect(
      (
        await h.handler({
          ...created,
          headers: { ...created.headers, "content-type": "text/plain" },
        })
      ).statusCode,
    ).toBe(415);
  });
  it("binds each named consumer and job to its exact synthesized context, not AWS defaults", () => {
    for (const consumer of [
      "materializeReview",
      "materializeAsset",
      "deliverNotification",
      "publishContent",
    ] as const) {
      for (const role of ["worker", "collector"] as const) {
        const env = {
          ...environment,
          AWS_LAMBDA_FUNCTION_NAME: `content-operations-local-${consumer.toLowerCase()}-${role}`,
          CONTENT_OPS_CONSUMER: consumer,
          CONTENT_OPS_QUEUE_ARN: `arn:aws:sqs:us-east-1:000000000000:content-operations-local-${consumer.toLowerCase()}-${role === "worker" ? "queue" : "dlq"}`,
        };
        expect(synthesisContext(role, env).consumer).toBe(consumer);
        expect(() =>
          synthesisContext(role, { ...env, CONTENT_OPS_QUEUE_ARN: "foreign" }),
        ).toThrow();
      }
    }
    for (const job of ["duePublication", "dueReview", "expireUploads", "cleanupOrphans"])
      expect(
        synthesisContext("scheduler", {
          ...environment,
          AWS_LAMBDA_FUNCTION_NAME: `content-operations-local-${job.toLowerCase()}-scheduler`,
          JAWSTACK_SCHEDULE_NAME: job,
        }).job,
      ).toBe(job);
    for (const extra of [
      { JAWSTACK_AUTH_MODE: "external" },
      { CONTENT_OPS_RUNTIME: "aws" },
      { LOCALSTACK_HOSTNAME: "" },
      { AWS_ENDPOINT_URL: "https://dynamodb.us-east-1.amazonaws.com" },
      { AWS_ENDPOINT_URL_DYNAMODB: "http://172.21.0.2:4566" },
      { AWS_LAMBDA_FUNCTION_NAME: "foreign" },
    ])
      expect(() => synthesisContext("api", { ...environment, ...extra })).toThrow();
    expect(environment.JAWSTACK_AUTH_MODE).toBe("dev");
  });
});
