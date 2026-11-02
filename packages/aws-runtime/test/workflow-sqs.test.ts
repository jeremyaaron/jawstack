import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createWorkflowSqsHandlers } from "../src/index";
import { defineWorker } from "@jawstack/core";
import { fixture, auth } from "./support/workflow";
import { WorkflowClient } from "./support/workflow-client";

const sourceQueueArn = "arn:aws:sqs:us-east-1:000000000000:documents-process",
  deadLetterQueueArn = `${sourceQueueArn}-dlq`;
function batch(facts: unknown[], arn = sourceQueueArn) {
  return {
    Records: facts.map((fact, i) => ({
      messageId: `message_${i}`,
      eventSource: "aws:sqs",
      awsRegion: "us-east-1",
      eventSourceARN: arn,
      body: JSON.stringify(fact),
      attributes: { ApproximateReceiveCount: "1" },
    })),
  };
}
function harness(backend: "memory" | "dynamo" = "memory", size = 1) {
  const handle = vi.fn(),
    client = new WorkflowClient();
  const h = fixture(backend, {
    client,
    change: (input) => ({
      ...input,
      consumers: { process: { recovery: "replay", batchSize: size } },
    }),
    runtime: { bind: () => ({ process: { handle } }) },
  });
  const handlers = createWorkflowSqsHandlers({
    runtime: h.runtime,
    consumer: "process",
    sourceQueueArn,
    deadLetterQueueArn,
  });
  return { ...h, ...handlers, client, handle };
}
describe("strict workflow SQS binding", () => {
  it("offers the same pure bounded transport parse without reads or business authority", async () => {
    const h = harness("dynamo");
    h.client.calls = [];
    expect(h.parse(batch([h.original]))).toEqual([h.original]);
    expect(h.client.calls).toEqual([]);
    expect(h.handle).not.toHaveBeenCalled();
    const forged = {
      ...h.original,
      eventId: "forged",
      payload: {
        ...h.original.payload,
        delivery: {
          originalEventId: h.original.eventId,
          generation: 1,
          consumer: "process",
          failureId: "a".repeat(64),
        },
      },
    };
    expect(h.parse(batch([forged]))).toHaveLength(1);
    expect(h.client.calls).toEqual([]);
    await expect(h.worker(batch([forged]))).rejects.toMatchObject({ code: "command.rejected" });
    expect(h.handle).not.toHaveBeenCalled();
    expect(() => h.parse(batch([h.original, h.original]))).toThrow(
      "Invalid workflow delivery batch.",
    );
    await h.runtime.close();
  });
  it.each(["memory", "dynamo"] as const)(
    "processes/collects duplicates through the shared %s runtime",
    async (backend) => {
      const h = harness(backend);
      expect(await h.worker(batch([h.original]))).toEqual({ seen: 1, processed: 1, skipped: 0 });
      expect(await h.worker(batch([h.original]))).toEqual({ seen: 1, processed: 0, skipped: 1 });
      expect(h.handle).toHaveBeenCalledTimes(1);
      expect(await h.collector(batch([h.original], deadLetterQueueArn))).toEqual({
        seen: 1,
        processed: 1,
        skipped: 0,
      });
      expect(await h.collector(batch([h.original], deadLetterQueueArn))).toEqual({
        seen: 1,
        processed: 0,
        skipped: 1,
      });
      await h.runtime.close();
    },
  );
  it("requires exact registered consumer and distinct compatible source/DLQ ARNs", async () => {
    const h = harness();
    for (const change of [
      { consumer: "other" },
      { sourceQueueArn: "not-an-arn" },
      { deadLetterQueueArn: sourceQueueArn },
      { deadLetterQueueArn: deadLetterQueueArn.replace("us-east-1", "us-west-2") },
      { deadLetterQueueArn: deadLetterQueueArn.replace("000000000000", "123456789012") },
    ])
      expect(() =>
        createWorkflowSqsHandlers({
          runtime: h.runtime,
          consumer: "process",
          sourceQueueArn,
          deadLetterQueueArn,
          ...change,
        }),
      ).toThrow(/binding/);
    await h.runtime.close();
  });
  it("rejects unknown option overrides and getters during binding", async () => {
    const h = harness(),
      getter = vi.fn();
    expect(() =>
      createWorkflowSqsHandlers({
        runtime: h.runtime,
        consumer: "process",
        sourceQueueArn,
        deadLetterQueueArn,
        batchSize: 10,
      } as never),
    ).toThrow(/binding/);
    expect(() =>
      createWorkflowSqsHandlers(
        Object.defineProperty({}, "runtime", { enumerable: true, get: getter }) as never,
      ),
    ).toThrow(/binding/);
    expect(getter).not.toHaveBeenCalled();
    await h.runtime.close();
  });
  it("permits ten records only with an explicit declaration of that batch size", async () => {
    const h = harness("memory", 10);
    expect(
      await h.worker(
        batch(Array.from({ length: 10 }, (_, i) => ({ ...h.original, eventId: `event_${i}` }))),
      ),
    ).toEqual({ seen: 10, processed: 10, skipped: 0 });
    await h.runtime.close();
  });
  it("acknowledges only authenticated non-target recovery fanout without a marker or business effect", async () => {
    const client = new WorkflowClient(),
      observe = vi.fn();
    const h = fixture("dynamo", {
      client,
      change: (input) => ({
        ...input,
        resources: [
          {
            ...input.resources[0]!,
            workers: [
              ...input.resources[0]!.workers,
              defineWorker({ name: "observe", eventTypes: ["document.changed"] }),
            ],
          },
        ],
        consumers: { process: { recovery: "replay" }, observe: { recovery: "replay" } },
      }),
      runtime: { bind: () => ({ process: { handle: () => {} }, observe: { handle: observe } }) },
    });
    await h.runtime.delivery.collect("process", h.original);
    await h.runtime.operations.replay(client.decoded("APP_FAILURE")[0]!.id, auth(), randomUUID());
    const wire = client.decoded("OUTBOX_EVENT")[0]!.event;
    const handlers = createWorkflowSqsHandlers({
      runtime: h.runtime,
      consumer: "observe",
      sourceQueueArn,
      deadLetterQueueArn,
    });
    client.calls = [];
    expect(await handlers.worker(batch([wire]))).toEqual({ seen: 1, processed: 0, skipped: 1 });
    expect(observe).not.toHaveBeenCalled();
    expect(client.calls.every((call) => !JSON.stringify(call.input).includes("WORKER#"))).toBe(
      true,
    );
    await expect(
      handlers.worker(batch([{ ...wire, payload: { ...wire.payload, title: "forged" } }])),
    ).rejects.toMatchObject({ code: "command.rejected" });
    await h.runtime.close();
  });
  it.each([
    "empty",
    "tooMany",
    "queue",
    "source",
    "region",
    "body",
    "outerSource",
    "outerType",
    "subscription",
    "schema",
    "identity",
    "tenant",
    "bytes",
    "duplicateId",
  ])("rejects %s before any marker or handler", async (variant) => {
    const h = harness("dynamo", variant === "duplicateId" ? 2 : 1);
    const input = batch([h.original]);
    const row = input.Records[0]!;
    if (variant === "empty") input.Records = [];
    if (variant === "tooMany") input.Records.push({ ...row, messageId: "another" });
    if (variant === "queue") row.eventSourceARN = deadLetterQueueArn;
    if (variant === "source") row.eventSource = "aws:sns";
    if (variant === "region") row.awsRegion = "us-west-2";
    if (variant === "body") row.body = "{";
    if (variant === "outerSource")
      row.body = JSON.stringify({ source: "foreign", detail: h.original });
    if (variant === "outerType")
      row.body = JSON.stringify({ "detail-type": "other.fact", detail: h.original });
    if (variant === "subscription")
      row.body = JSON.stringify({ ...h.original, eventType: "unsubscribed.changed" });
    if (variant === "schema") row.body = JSON.stringify({ ...h.original, schemaVersion: 2 });
    if (variant === "identity") row.body = JSON.stringify({ ...h.original, resourceId: "wrong" });
    if (variant === "tenant") row.body = JSON.stringify({ ...h.original, tenantId: "foreign" });
    if (variant === "bytes") row.body = "x".repeat(180225);
    if (variant === "duplicateId") input.Records.push({ ...row });
    await expect(h.worker(input)).rejects.toMatchObject({ code: "command.validation" });
    expect(h.handle).not.toHaveBeenCalled();
    expect(h.client.calls).toEqual([]);
    await h.runtime.close();
  });
  it("validates the final record before processing an earlier valid fact", async () => {
    const h = harness("dynamo", 2);
    const input = batch([
      h.original,
      { ...h.original, eventId: "second", payload: { id: "wrong", title: "Draft" } },
    ]);
    await expect(h.worker(input)).rejects.toMatchObject({ code: "command.validation" });
    expect(h.handle).not.toHaveBeenCalled();
    expect(h.client.calls).toEqual([]);
    await h.runtime.close();
  });
  it.each(["worker", "collector"] as const)(
    "authorizes every recovery before the first %s marker, including existing duplicate markers",
    async (role) => {
      const h = harness("dynamo", 2);
      await h.runtime.delivery.collect("process", h.original);
      const id = h.client.decoded("APP_FAILURE")[0]!.id;
      await h.runtime.operations.replay(id, auth(), randomUUID());
      const replay = h.client.decoded("OUTBOX_EVENT")[0]!.event;
      await h.runtime.delivery.handle("process", replay);
      h.handle.mockClear();
      h.client.calls = [];
      const forged = { ...replay, payload: { ...replay.payload, title: "forged" } };
      const input = batch(
        [h.original, forged],
        role === "worker" ? sourceQueueArn : deadLetterQueueArn,
      );
      await expect(h[role](input)).rejects.toMatchObject({ code: "command.rejected" });
      expect(h.client.calls.every((call) => !JSON.stringify(call.input).includes("WORKER#"))).toBe(
        true,
      );
      expect(h.handle).not.toHaveBeenCalled();
      await h.runtime.close();
    },
  );
  it("supports matching EventBridge wrappers including string detail and captures the batch before yielding", async () => {
    const h = harness("memory", 2);
    const input = batch([
      {
        source: "documents",
        "detail-type": h.original.eventType,
        detail: JSON.stringify(h.original),
      },
      { ...h.original, eventId: "second" },
    ]);
    const pending = h.worker(input);
    input.Records[1]!.body = "invalid after entry";
    expect(await pending).toEqual({ seen: 2, processed: 2, skipped: 0 });
    expect(h.handle).toHaveBeenCalledTimes(2);
    await h.runtime.close();
  });
  it("throws for whole-batch retry on a handler failure, retaining earlier successful markers", async () => {
    const h = harness("memory", 2);
    h.handle
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("provider unavailable");
      });
    const input = batch([h.original, { ...h.original, eventId: "second" }]);
    await expect(h.worker(input)).rejects.toThrow("provider unavailable");
    h.handle.mockImplementation(() => {});
    expect(await h.worker(input)).toEqual({ seen: 2, processed: 1, skipped: 1 });
    await h.runtime.close();
  });
  it("does not acknowledge deferred admission as a successful whole batch", async () => {
    const h = harness();
    const handlers = createWorkflowSqsHandlers({
      runtime: {
        ...h.runtime,
        delivery: { ...h.runtime.delivery, handle: async () => ({ status: "deferred" }) },
      },
      consumer: "process",
      sourceQueueArn,
      deadLetterQueueArn,
    });
    await expect(handlers.worker(batch([h.original]))).rejects.toMatchObject({
      code: "runtime.unavailable",
    });
    await h.runtime.close();
  });
  it("does not execute input getters or accept non-JSON metadata", async () => {
    const h = harness("dynamo");
    const getter = vi.fn();
    const input = Object.defineProperty({}, "Records", { enumerable: true, get: getter });
    await expect(h.worker(input)).rejects.toMatchObject({ code: "command.validation" });
    expect(getter).not.toHaveBeenCalled();
    await expect(h.worker({ ...batch([h.original]), extra: undefined })).rejects.toMatchObject({
      code: "command.validation",
    });
    expect(h.client.calls).toEqual([]);
    await h.runtime.close();
  });
});
