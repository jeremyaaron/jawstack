import { GetItemCommand, QueryCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDbClientLike, DynamoDbItem } from "@jawstack/aws-runtime";
import type { JawStackEvent } from "@jawstack/core";
import { describe, expect, it } from "vitest";
import {
  createMemoryNotificationSink,
  notificationKey,
  notificationOperation,
  notificationOperationKey,
  renderNotification,
  type NotificationSink,
} from "../../src/application/notifications";
import { createDynamoNotificationSink } from "../../src/aws/notifications";
import { parseContentEvent } from "../../src/shared/events";

const instant = "2026-10-31T12:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fact = (n = 1): JawStackEvent => ({
  envelopeVersion: 1,
  schemaVersion: 1,
  source: "content-operations",
  eventId: `event_${n}`,
  eventType: "contentItem.reviewRequested",
  resourceType: "contentItem",
  resourceId: uuid(1),
  correlationId: "correlation",
  causationId: "command",
  occurredAt: instant,
  payload: {
    reviewId: uuid(n + 10),
    contentId: uuid(1),
    assignedEditorId: "editor_1",
    dueAt: "2026-11-01T12:00:00.000Z",
    lastReminderDay: null,
    status: "pending",
    sourceVersion: 2,
    decision: null,
    submitted: {
      contentId: uuid(1),
      authorId: "author_1",
      revisionId: uuid(2),
      title: `Editorial ${n}`,
      body: "Body",
      attachments: [],
      submittedAt: instant,
    },
  },
});
const render = (n = 1, now = instant) =>
  renderNotification(parseContentEvent(fact(n)), new Date(now));
const key = (item: DynamoDbItem) => JSON.stringify([item.PK, item.SK]);

class NotificationClient implements DynamoDbClientLike {
  items = new Map<string, DynamoDbItem>();
  transactions: TransactWriteItemsCommand["input"][] = [];
  mode: "normal" | "failure" | "ambiguous" = "normal";
  readFails = false;
  async send(command: { input: unknown }): Promise<unknown> {
    if (command instanceof GetItemCommand) {
      expect(command.input.ConsistentRead).toBe(true);
      if (this.readFails) throw new Error("sensitive read diagnostics");
      return { Item: structuredClone(this.items.get(key(command.input.Key!))) };
    }
    if (command instanceof QueryCommand) {
      expect(command.input.ConsistentRead).toBe(true);
      const values = unmarshall(command.input.ExpressionAttributeValues!);
      const after = command.input.ExclusiveStartKey?.SK?.S;
      const matching = [...this.items.values()]
        .filter(
          (item) =>
            item.PK?.S === values[":pk"] &&
            item.itemKind?.S === values[":kind"] &&
            (!after || item.SK!.S! > after),
        )
        .sort((a, b) => Buffer.compare(Buffer.from(a.SK!.S!), Buffer.from(b.SK!.S!)));
      const items = matching.slice(0, command.input.Limit);
      const last = items.at(-1);
      return {
        Items: items,
        ...(matching.length > items.length && last
          ? { LastEvaluatedKey: { PK: last.PK, SK: last.SK } }
          : {}),
      };
    }
    if (!(command instanceof TransactWriteItemsCommand)) throw new Error("Unexpected SDK command");
    this.transactions.push(structuredClone(command.input));
    if (this.mode === "failure") throw new Error("sensitive transaction diagnostics");
    const writes = command.input.TransactItems!;
    expect(writes).toHaveLength(4);
    const keys = writes.map((item) => key(item.Put!.Item!));
    expect(new Set(keys).size).toBe(4);
    expect(
      writes.every((item) => item.Put!.ConditionExpression === "attribute_not_exists(PK)"),
    ).toBe(true);
    const reasons = keys.map((value) => ({
      Code: this.items.has(value) ? "ConditionalCheckFailed" : "None",
    }));
    if (reasons.some((r) => r.Code !== "None"))
      throw Object.assign(new Error("Cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: reasons,
      });
    const staged = structuredClone(this.items);
    writes.forEach((write, i) => staged.set(keys[i]!, structuredClone(write.Put!.Item!)));
    this.items = staged;
    if (this.mode === "ambiguous") throw new Error("Lost committed response");
    return {};
  }
}
function harness(adapter: "memory" | "dynamo") {
  const memory = createMemoryNotificationSink();
  const client = new NotificationClient();
  const sink: NotificationSink =
    adapter === "memory" ? memory : createDynamoNotificationSink({ client, tableName: "test" });
  const snapshot = () =>
    structuredClone(
      adapter === "memory"
        ? {
            deliveries: memory.deliveries,
            operations: memory.operations,
            projections: memory.store.projections,
          }
        : client.items,
    );
  return { sink, client, memory, snapshot };
}

describe.each(["memory", "dynamo"] as const)("%s notification destination", (adapter) => {
  it("atomically creates one delivery, operation and two query rows under concurrent duplicates", async () => {
    const h = harness(adapter);
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        h.sink.deliver(render(1, new Date(Date.parse(instant) + i * 1000).toISOString())),
      ),
    );
    for (const result of results) expect(result).toEqual(results[0]);
    expect(await h.sink.get(results[0]!.deliveryId)).toEqual(results[0]);
    expect((await h.sink.query()).items.map((row) => row.data)).toEqual([results[0]]);
    expect((await h.sink.query({ recipientId: "editor_1" })).items).toHaveLength(1);
    expect((await h.sink.query({ recipientId: "author_1" })).items).toHaveLength(0);
    if (adapter === "memory") {
      expect(h.memory.operations.size).toBe(1);
      expect(h.memory.store.projections.size).toBe(2);
    } else {
      expect(h.client.items.size).toBe(4);
      expect(
        [...h.client.items.values()]
          .map((item) => unmarshall(item))
          .every((row) => !("expiresAt" in row)),
      ).toBe(true);
    }
  });

  it("deduplicates replay transport IDs after marker TTL without changing the first response or metadata", async () => {
    const h = harness(adapter);
    const first = await h.sink.deliver(render());
    const before = h.snapshot();
    const replay = parseContentEvent({
      ...fact(),
      eventId: "transport_replay",
      correlationId: "replay_correlation",
      occurredAt: "2026-11-10T12:00:00.000Z",
      payload: {
        ...(fact().payload as object),
        delivery: { originalEventId: fact().eventId, generation: 1 },
      },
    });
    expect(
      await h.sink.deliver(renderNotification(replay, new Date("2026-11-10T12:00:00.000Z"))),
    ).toEqual(first);
    expect(h.snapshot()).toEqual(before);
    const copy = await h.sink.get(first.deliveryId);
    copy!.message = "mutated copy";
    expect((await h.sink.get(first.deliveryId))!.message).toBe(first.message);
  });

  it("rejects conflicting reuse without replacing the destination or query rows", async () => {
    const h = harness(adapter);
    const delivery = render();
    await h.sink.deliver(delivery);
    const before = h.snapshot();
    await expect(
      h.sink.deliver({ ...delivery, message: "Different rendering" }),
    ).rejects.toMatchObject({ code: "resource.conflict" });
    expect(h.snapshot()).toEqual(before);
  });

  it("rolls back all new records when an auxiliary condition fails", async () => {
    const h = harness(adapter);
    const delivery = render();
    if (adapter === "memory")
      h.memory.operations.set(delivery.deliveryId, notificationOperation(delivery));
    else {
      const item = marshall({
        ...notificationOperationKey(delivery.deliveryId),
        itemKind: "APP_OPERATION",
        ...notificationOperation(delivery),
      });
      h.client.items.set(key(item), item);
    }
    const before = h.snapshot();
    await expect(h.sink.deliver(delivery)).rejects.toMatchObject({ code: "resource.conflict" });
    expect(h.snapshot()).toEqual(before);
    expect(await h.sink.get(delivery.deliveryId)).toBeUndefined();
    expect((await h.sink.query()).items).toEqual([]);
  });

  it("pages tied delivery instants without losing/duplicating visible records", async () => {
    const h = harness(adapter);
    for (let i = 1; i <= 7; i++) await h.sink.deliver(render(i));
    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await h.sink.query({ limit: 2, ...(cursor ? { cursor } : {}) });
      collected.push(...result.items.map((item) => item.itemId));
      cursor = result.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(4);
    expect(new Set(collected).size).toBe(7);
    expect(collected).toEqual((await h.sink.query()).items.map((item) => item.itemId));
    await expect(h.sink.query({ limit: 101 })).rejects.toThrow();
    await expect(h.sink.query({ recipientId: "untrusted-partition" as never })).rejects.toThrow();
  });
});

describe("notification failure and schema guards", () => {
  it("rejects malformed destination records before sending a transaction", async () => {
    const client = new NotificationClient();
    const sink = createDynamoNotificationSink({ client, tableName: "test" });
    for (const delivery of [
      { ...render(), deliveryId: "0".repeat(64) },
      { ...render(), sourceEventId: "bad\n" },
      { ...render(), message: "x".repeat(1001) },
      { ...render(), expiresAt: 1 },
    ])
      await expect(sink.deliver(delivery)).rejects.toThrow();
    expect(client.transactions).toHaveLength(0);
    expect(client.items.size).toBe(0);
  });

  it("recovers an ambiguous committed transaction by strongly rereading, never issuing a second write", async () => {
    const client = new NotificationClient();
    client.mode = "ambiguous";
    const sink = createDynamoNotificationSink({ client, tableName: "test" });
    const delivery = render();
    expect(await sink.deliver(delivery)).toEqual(delivery);
    expect(await sink.deliver(delivery)).toEqual(delivery);
    expect(client.transactions).toHaveLength(1);
    expect(client.items.size).toBe(4);
  });

  it("sanitizes service failures without creating any partial records", async () => {
    const client = new NotificationClient();
    client.mode = "failure";
    const sink = createDynamoNotificationSink({ client, tableName: "test" });
    await expect(sink.deliver(render())).rejects.toMatchObject({
      code: "runtime.unavailable",
      message: "Notification transaction did not complete.",
    });
    expect(client.items.size).toBe(0);
    client.readFails = true;
    await expect(sink.get(render().deliveryId)).rejects.toMatchObject({
      code: "runtime.unavailable",
      message: "Notification read failed.",
    });
  });

  it("rejects corrupt stored records and malformed replay metadata", async () => {
    const client = new NotificationClient();
    const sink = createDynamoNotificationSink({ client, tableName: "test" });
    const delivery = render();
    const corrupt = marshall({
      ...notificationKey(delivery.deliveryId),
      itemKind: "WRONG_KIND",
      ...delivery,
    });
    client.items.set(key(corrupt), corrupt);
    await expect(sink.deliver(delivery)).rejects.toMatchObject({ code: "resource.invalid_state" });
    for (const metadata of [
      { originalEventId: "original", generation: 0 },
      { originalEventId: "original", generation: 4 },
      { originalEventId: "bad\n", generation: 1 },
      { originalEventId: "original", generation: 1, unknown: true },
    ])
      expect(() =>
        parseContentEvent({
          ...fact(),
          payload: { ...(fact().payload as object), delivery: metadata },
        }),
      ).toThrow();
  });

  it("keeps permanent business deduplication at capacity and refuses new deliveries rather than evicting old ones", async () => {
    const sink = createMemoryNotificationSink({ maxDeliveries: 1 });
    const delivery = render();
    await sink.deliver(delivery);
    await expect(sink.deliver(render(2))).rejects.toMatchObject({ code: "runtime.unavailable" });
    expect(await sink.deliver(delivery)).toEqual(delivery);
    expect((await sink.query()).items).toHaveLength(1);
    expect(() => createMemoryNotificationSink({ maxDeliveries: 0 })).toThrow();
  });
});
