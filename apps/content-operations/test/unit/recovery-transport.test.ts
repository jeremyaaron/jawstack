import {
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { createFailureSqsHandler, createContentWorkerSqsHandler } from "../../src/aws/recovery";
import { createFailureService } from "../../src/application/failures";
import { createDynamoFailureStore } from "../../src/aws/failures";
import { createPublisher, SimulatedPublicationCrash } from "../../src/application/publisher";
import { createContentWorkers } from "../../src/application/workers";
import {
  failedDeliveryId,
  failureKey,
  replayEnvelope,
} from "../../src/application/failure-records";
import { fixtureAuth } from "../../src/shared/identities";
import { editorialHarness } from "../support/editorial";
import { itemKey, TransactionClient } from "../support/transaction-client";
import { randomUUID } from "node:crypto";
import { workerIdempotencyKey } from "@jawstack/aws-runtime";
import { marshall } from "@aws-sdk/util-dynamodb";

class MarkerClient extends TransactionClient {
  markers = 0;
  reads = 0;
  failMarker = false;
  failTransaction = false;
  beforeMark: (() => void) | undefined;
  override async send(command: { input: unknown }): Promise<unknown> {
    if (command instanceof TransactWriteItemsCommand && this.failTransaction)
      throw new Error("private transaction failure");
    if (command instanceof GetItemCommand) this.reads++;
    if (!(command instanceof PutItemCommand)) return super.send(command);
    this.beforeMark?.();
    if (this.failMarker) throw new Error("sensitive marker failure");
    const item = command.input.Item!;
    const key = itemKey(item);
    if (this.items.has(key))
      throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
    this.items.set(key, structuredClone(item));
    this.markers++;
    return {};
  }
}
const queue = "arn:aws:sqs:us-east-1:000000000000:jawstack-content-ops-test-notification-dlq";
const source = "content-operations";
async function harness() {
  const h = editorialHarness();
  await h.create("review");
  const client = new MarkerClient();
  const store = createDynamoFailureStore({ source, client, tableName: "test" });
  const failures = createFailureService({
    source,
    store,
    repository: h.app.persistence.repository,
    dispatch: h.app.dispatch,
    clock: h.clock.now,
  });
  const event = h.app.persistence.store.outbox.find(
    (e) => e.eventType === "contentItem.reviewRequested",
  )!;
  const transport = {
    client,
    tableName: "test",
    source,
    consumer: "deliverNotification" as const,
    expectedQueueArn: queue,
    clock: h.clock.now,
  };
  const handler = createFailureSqsHandler({ ...transport, failures });
  const batch = () => ({
    Records: [
      {
        messageId: "message-1",
        eventSourceARN: queue,
        body: JSON.stringify({ source, "detail-type": event.eventType, detail: event }),
      },
    ],
  });
  return { ...h, client, store, failures, event, transport, handler, batch };
}
describe("durable collection acknowledgements", () => {
  it("does not acknowledge when durable collection cannot commit", async () => {
    const h = await harness();
    h.client.failTransaction = true;
    await expect(h.handler(h.batch())).rejects.toMatchObject({ code: "runtime.unavailable" });
    expect(h.client.markers).toBe(0);
    expect(
      await h.store.get(failedDeliveryId("deliverNotification", h.event.eventId)),
    ).toBeUndefined();
    h.client.failTransaction = false;
    expect(await h.handler(h.batch())).toMatchObject({ processed: 1 });
  });
  it("marks only after collection/reconciliation, and recovers a marker-write failure", async () => {
    const h = await harness();
    const id = failedDeliveryId("deliverNotification", h.event.eventId);
    h.client.beforeMark = () => {
      const item = [...h.client.items.values()].find((i) => i.PK?.S === failureKey(id).PK)!;
      const record = unmarshall(item);
      expect((record.collections as { resolution: string }[])[0]!.resolution).toBe("notApplicable");
    };
    h.client.failMarker = true;
    await expect(h.handler(h.batch())).rejects.toMatchObject({ code: "runtime.unavailable" });
    expect(h.client.markers).toBe(0);
    const record = await h.store.get(id);
    h.client.failMarker = false;
    expect(await h.handler(h.batch())).toMatchObject({ processed: 1 });
    expect(await h.store.get(id)).toEqual(record);
    expect(await h.handler(h.batch())).toMatchObject({ skipped: 1 });
  });
  it("never marks a collector crash after recording, and rejects cached foreign deliveries before SDK reads", async () => {
    const h = await harness();
    const broken = createFailureService({
      source,
      store: h.store,
      repository: h.app.persistence.repository,
      dispatch: h.app.dispatch,
      clock: h.clock.now,
      fault: (point) => {
        if (point === "afterRecord") throw new Error("collector stopped");
      },
    });
    await expect(
      createFailureSqsHandler({ ...h.transport, failures: broken })(h.batch()),
    ).rejects.toThrow("collector stopped");
    expect(h.client.markers).toBe(0);
    expect(await h.handler(h.batch())).toMatchObject({ processed: 1 });
    const reads = h.client.reads;
    const record = h.batch().Records[0]!;
    const foreign = { ...record, eventSourceARN: "foreign" };
    await expect(
      h.handler({ Records: [{ ...record, body: "private-payload-fragment" }] }),
    ).rejects.toMatchObject({ message: "Invalid application delivery batch." });
    await expect(h.handler({ Records: [foreign] })).rejects.toThrow();
    await expect(
      h.handler({ Records: [record, { ...record, body: "invalid-json" }] }),
    ).rejects.toThrow();
    await expect(
      h.handler({
        Records: [{ ...record, body: JSON.stringify({ ...h.event, source: "foreign" }) }],
      }),
    ).rejects.toThrow();
    expect(h.client.reads).toBe(reads);
  });
  it("retries a whole batch without acknowledging its live-claimed second publication", async () => {
    const h = editorialHarness();
    await h.create("scheduled");
    await h.create("scheduled");
    h.clock.advance(3_600_000);
    await h.app.jobs.tick("duePublication");
    const events = h.app.persistence.store.outbox.filter(
      (e) => e.eventType === "contentItem.publicationRequested",
    );
    const publisher = createPublisher({
      repository: h.app.persistence.repository,
      dispatch: h.app.dispatch,
      objects: h.app.objects,
      clock: h.clock.now,
    });
    const { parseContentEvent } = await import("../../src/shared/events");
    await publisher(parseContentEvent(events[0]));
    await expect(
      createPublisher({
        repository: h.app.persistence.repository,
        dispatch: h.app.dispatch,
        objects: h.app.objects,
        clock: h.clock.now,
        fault: (point) => {
          if (point === "afterClaim") throw new SimulatedPublicationCrash();
        },
      })(parseContentEvent(events[1])),
    ).rejects.toThrow();
    const client = new MarkerClient();
    const dlq = queue.replace("notification", "publication");
    const handler = createFailureSqsHandler({
      client,
      tableName: "test",
      expectedQueueArn: dlq,
      source,
      consumer: "publishContent",
      failures: h.app.failures,
      clock: h.clock.now,
    });
    const batch = {
      Records: events.map((event, index) => ({
        messageId: `message-${index}`,
        eventSourceARN: dlq,
        body: JSON.stringify(event),
      })),
    };
    await expect(handler(batch)).rejects.toMatchObject({ code: "resource.conflict" });
    expect(client.markers).toBe(1);
    h.clock.advance(90_000);
    expect(await handler(batch)).toMatchObject({ processed: 1, skipped: 1 });
    expect(client.markers).toBe(2);
    expect(h.app.failureStore.records.size).toBe(2);
  });
});
describe("targeted worker replay transport", () => {
  it("commits one business delivery before its marker, then deduplicates marker gaps/physical expiry", async () => {
    const h = await harness();
    const id = failedDeliveryId("deliverNotification", h.event.eventId);
    await h.failures.collect("deliverNotification", h.event);
    await h.failures.replay(id, fixtureAuth("editor_1"), randomUUID());
    const record = (await h.store.get(id))!;
    const replay = replayEnvelope(record, record.recoveries[0]!);
    const workers = createContentWorkers({
      repository: h.app.persistence.repository,
      dispatch: h.app.dispatch,
      notifications: h.app.notifications,
      recovery: h.failures,
      clock: h.clock.now,
    });
    const q = queue.replace("-dlq", "");
    const handler = createContentWorkerSqsHandler({
      ...h.transport,
      expectedQueueArn: q,
      workers,
      recovery: h.failures,
    });
    const batch = {
      Records: [{ messageId: "replay", eventSourceARN: q, body: JSON.stringify(replay) }],
    };
    h.client.failMarker = true;
    await expect(handler(batch)).rejects.toMatchObject({ code: "runtime.unavailable" });
    expect(h.app.notifications.deliveries.size).toBe(1);
    expect((await h.store.get(id))!.resolvedGeneration).toBe(1);
    h.client.failMarker = false;
    expect(await handler(batch)).toMatchObject({ processed: 1 });
    const markerKey = workerIdempotencyKey("deliverNotification", replay.eventId);
    expect(unmarshall(h.client.items.get(itemKey(marshall(markerKey)))!).expiresAt).toBe(
      Math.floor(h.clock.now().getTime() / 1000) + 7 * 24 * 3600,
    );
    h.client.items.delete(itemKey(marshall(markerKey)));
    await handler(batch);
    expect(h.app.notifications.deliveries.size).toBe(1);
    const forged = { ...replay, eventId: randomUUID() };
    await expect(
      handler({ Records: [{ ...batch.Records[0]!, body: JSON.stringify(forged) }] }),
    ).rejects.toMatchObject({ code: "command.rejected" });
    await expect(
      handler({
        Records: [
          {
            ...batch.Records[0]!,
            body: JSON.stringify({
              ...replay,
              payload: { ...replay.payload, dueAt: "2026-11-02T12:00:00.000Z" },
            }),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "command.rejected" });
    const spy = vi.spyOn(h.app.notifications, "deliver");
    expect(await workers.handle("materializeReview", replay)).toBe("ignored");
    expect(spy).not.toHaveBeenCalled();
  });
});
