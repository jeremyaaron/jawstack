import { readFileSync } from "node:fs";
import { GetItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  createWorkflowCommitPlanner,
  defineAtomicRecord,
  defineCommand,
  defineResource,
  defineState,
  defineWorker,
  defineWorkflow,
  field,
  type WorkflowCommitPlan,
  type WorkflowCommandScope,
} from "@jawstack/core";
import { createDynamoWorkflow } from "../src/index";
import {
  boundedTransaction,
  compileWorkflowCommit,
  transactionError,
} from "../src/workflow/compiler";
import { WorkflowClient } from "./support/workflow-client";
import { initial } from "./support/workflow";

const golden = JSON.parse(
  readFileSync(
    new URL(
      "../../../docs/iterations/003-framework-leverage/leverage/compatibility.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
function compilerFixture() {
  const receipt = defineAtomicRecord({
    name: "commandReceipt",
    schema: z.strictObject({
      kind: z.literal("commandReceipt"),
      resourceType: z.string(),
      resourceId: z.string(),
      commandName: z.string(),
      subject: z.string(),
      version: z.number(),
      committedAt: z.string(),
    }),
    key: (r) => `${r.resourceType}#${r.resourceId}#${r.version}`,
    owner: (r) => ({ resourceType: r.resourceType, resourceId: r.resourceId }),
  });
  const planner = createWorkflowCommitPlanner({
    workflowName: "content-operations",
    source: "content-operations",
    idempotencyTtlSeconds: 604800,
    records: [receipt],
    contribute: ({ invocation, commit }) => ({
      records: [
        receipt.create({
          kind: "commandReceipt",
          ...invocation.scope,
          resourceId: commit.resource.resourceId,
          version: commit.resource.next.version,
          committedAt: invocation.now,
        }),
      ],
    }),
  });
  const scope: WorkflowCommandScope = {
    resourceType: "contentItem",
    commandName: "create",
    subject: "author_1",
  };
  const plan = planner.plan({ scope, now: initial }, golden.commandInput);
  return { planner, plan };
}
describe("known workflow plan compiler", () => {
  it("matches every frozen command row, preserves envelope bytes and applies exact conditions", () => {
    const { planner, plan } = compilerFixture();
    const compiled = compileWorkflowCommit(planner, plan, "fixture-table");
    expect(compiled.input.TransactItems!.map((write) => unmarshall(write.Put!.Item!))).toEqual(
      golden.decodedRows,
    );
    const event = compiled.input.TransactItems!.find(
      (write) => write.Put!.Item!.itemKind?.S === "OUTBOX_EVENT",
    )!;
    expect(JSON.stringify(unmarshall(event.Put!.Item!).event)).toBe(golden.wireJson);
    expect(compiled.roles).toEqual([
      "resource",
      "resource",
      "resource",
      "resource",
      "idempotency",
      "resource",
    ]);
    expect(compiled.input.TransactItems![4]!.Put!.ConditionExpression).toBe(
      "attribute_not_exists(PK) OR #expires <= :now",
    );
    for (const index of [0, 1, 2, 5])
      expect(compiled.input.TransactItems![index]!.Put!.ConditionExpression).toBe(
        "attribute_not_exists(PK)",
      );
    expect(compiled.input.TransactItems![3]!.Put!.ConditionExpression).toBeUndefined();
    expect(compiled.input.ClientRequestToken).toHaveLength(36);
    expect(compileWorkflowCommit(planner, plan, "fixture-table")).toEqual(compiled);
  });
  it("rejects forged/cloned/foreign plans before compilation", () => {
    const first = compilerFixture(),
      second = compilerFixture();
    for (const plan of [{}, structuredClone(first.plan), second.plan])
      expect(() =>
        compileWorkflowCommit(first.planner, plan as WorkflowCommitPlan, "table"),
      ).toThrow(/not produced/);
  });
  it.each([0, 61, 100, 101])("rejects %s actions under the narrower workflow budget", (count) => {
    const items = Array.from({ length: count }, (_, i) => ({
      Put: { TableName: "table", Item: marshall({ PK: `p${i}`, SK: "s" }) },
    }));
    expect(() =>
      boundedTransaction(
        items,
        items.map(() => "resource"),
      ),
    ).toThrow(/bounds/);
  });
  it("accepts sixty distinct small actions but rejects duplicate keys and mismatched roles", () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      Put: { TableName: "table", Item: marshall({ PK: `p${i}`, SK: "s" }) },
    }));
    expect(
      boundedTransaction(
        items,
        items.map(() => "resource"),
      ).input.TransactItems,
    ).toHaveLength(60);
    expect(() => boundedTransaction([items[0]!, items[0]!], ["resource", "resource"])).toThrow(
      /bounds/,
    );
    expect(() => boundedTransaction(items, ["resource"])).toThrow(/bounds/);
  });
  it("bounds encoded item and complete request size, including attribute wrappers", () => {
    const item = (i: number, size: number) => ({
      Put: {
        TableName: "table",
        Item: marshall({ PK: `p${i}`, SK: "s", value: "x".repeat(size) }),
      },
    });
    expect(() => boundedTransaction([item(0, 400 * 1024)], ["resource"])).toThrow(/bounds/);
    const items = Array.from({ length: 50 }, (_, i) => item(i, 90 * 1024));
    expect(() =>
      boundedTransaction(
        items,
        items.map(() => "resource"),
      ),
    ).toThrow(/bounds/);
    expect(
      boundedTransaction([item(0, 399 * 1024)], ["resource"]).input.TransactItems,
    ).toHaveLength(1);
  });
  it("includes observed deleted-item bytes, not only their tiny request keys", () => {
    const items = [{ Delete: { TableName: "table", Key: marshall({ PK: "p", SK: "s" }) } }];
    expect(() => boundedTransaction(items, ["resource"], 4 * 1024 * 1024)).toThrow(/bounds/);
    expect(() => boundedTransaction(items, ["resource"], -1)).toThrow(/bounds/);
    expect(boundedTransaction(items, ["resource"], 100).input.TransactItems).toHaveLength(1);
  });
  it("uses indexed known reasons, prioritizes scoped idempotency, and rejects partial/unknown classifications", () => {
    const roles = ["resource", "idempotency", "resource"] as const;
    const error = (codes: string[]) => ({
      name: "TransactionCanceledException",
      CancellationReasons: codes.map((Code) => ({ Code })),
    });
    expect(() =>
      transactionError(error(["ConditionalCheckFailed", "None", "None"]), roles),
    ).toThrow(expect.objectContaining({ code: "resource.conflict" }));
    expect(() =>
      transactionError(error(["ConditionalCheckFailed", "ConditionalCheckFailed", "None"]), roles),
    ).toThrow(expect.objectContaining({ code: "idempotency.conflict" }));
    for (const codes of [
      ["None"],
      ["None", "None", "None"],
      ["TransactionConflict", "ConditionalCheckFailed", "None"],
    ])
      expect(() => transactionError(error(codes), roles)).toThrow(
        expect.objectContaining({ code: "runtime.unavailable" }),
      );
  });
});

describe("Dynamo frozen recovery compatibility", () => {
  it("writes and reads the approved failure/projection/replay/marker formats through public services", async () => {
    const original = golden.failure.record.original;
    const worker = golden.failure.record.consumer;
    const schema = z.strictObject(
      Object.fromEntries(Object.keys(original.payload).map((key) => [key, z.unknown()])),
    );
    const definition = defineWorkflow({
      name: "compatibility",
      source: original.source,
      resources: [
        defineResource({
          name: original.resourceType,
          title: "Fixture",
          state: defineState({ title: field.string() }),
          commands: {
            create: defineCommand({
              title: "Create",
              create: true,
              roles: ["operator"],
              input: z.strictObject({}),
              emits: [{ eventType: original.eventType, schemaVersion: 1 }],
              decide: () => ({
                nextState: { title: "Fixture" },
                activity: [],
                events: [
                  { eventType: original.eventType, schemaVersion: 1, payload: original.payload },
                ],
                response: {},
              }),
            }),
          },
          workers: [defineWorker({ name: worker, eventTypes: [original.eventType] })],
        }),
      ],
      commands: { idempotencyTtlSeconds: 604800 },
      events: [
        {
          eventType: original.eventType,
          schemaVersion: 1,
          schema,
          validateIdentity: (event) => event.resourceId === event.payload.contentId,
        },
      ],
      consumers: { [worker]: { recovery: "replay" } },
      operations: {
        resourceType: original.resourceType,
        projection: `${original.resourceType}.failures`,
      },
    });
    const client = new WorkflowClient();
    let now = initial;
    const workflow = createDynamoWorkflow(definition, {
      client,
      tableName: "compatibility",
      clock: () => new Date(now),
      authorizeOperations: () => true,
      bind: () => ({ [worker]: { handle: () => {} } }),
    });
    await workflow.delivery.collect(worker, original);
    expect(client.decoded("WORKER_IDEMPOTENCY")).toEqual([unmarshall(golden.markers[1])]);
    const previous = client.decoded("APP_FAILURE")[0]!;
    const settled = { ...golden.failure.record, version: 2, recoveries: [] };
    const actual = Object.fromEntries(
      Object.entries(previous).filter(([key]) => !["PK", "SK", "itemKind"].includes(key)),
    );
    expect(actual).toEqual(settled);
    // Seed an approved recorded generation to exercise readback and exact legacy traffic;
    // the new writer must not rewrite the existing wire envelope/property ordering.
    client.put(
      marshall({ ...golden.failure.key, itemKind: "APP_FAILURE", ...golden.failure.record }),
    );
    client.put(golden.failure.projectionItem);
    now = golden.failure.record.recoveries[0].requestedAt;
    expect(
      await workflow.operations.inspect(
        { subject: "editor_1", roles: [], mode: "test", claims: {} },
        { id: golden.failure.record.id },
      ),
    ).toEqual(golden.failure.summary);
    expect(JSON.stringify(workflow.events.parse(JSON.parse(golden.replayJson)))).toBe(
      golden.replayJson,
    );
    await workflow.delivery.handle(worker, original);
    const marker = client.decoded("WORKER_IDEMPOTENCY").find((row) => row.workerName === worker)!;
    expect(marker).toEqual({
      ...unmarshall(golden.markers[0]),
      processedAt: now,
      expiresAt: Math.floor(Date.parse(now) / 1000) + 604800,
    });
    expect(
      client.calls
        .filter((call) => call instanceof GetItemCommand)
        .every((call) => call.input.ConsistentRead),
    ).toBe(true);
    expect(client.transactions.every((call) => call instanceof TransactWriteItemsCommand)).toBe(
      true,
    );
    await workflow.close();
  });
});
