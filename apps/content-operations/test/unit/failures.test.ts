import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { toOutboxEventItem } from "@jawstack/aws-runtime";
import { createFailureService } from "../../src/application/failures";
import {
  createMemoryFailureStore,
  failedDeliveryId,
  failureKey,
  replayEnvelope,
  type FailureStore,
} from "../../src/application/failure-records";
import { createDynamoFailureStore } from "../../src/aws/failures";
import { SimulatedPublicationCrash } from "../../src/application/publisher";
import { createMemoryPump, workerMarkerTtlMs } from "../../src/application/pump";
import { fixtureAuth } from "../../src/shared/identities";
import { JawStackRuntimeError } from "@jawstack/core";
import { publicationHarness } from "../support/publication";
import { editorialHarness } from "../support/editorial";
import { itemKey, TransactionClient } from "../support/transaction-client";
import { parseJobsArgs } from "../../scripts/jobs";

const source = "content-operations";
async function setup(adapter: "memory" | "dynamo" = "memory") {
  const h = editorialHarness();
  const id = await h.create("review");
  const event = h.app.persistence.store.outbox.find(
    (e) => e.eventType === "contentItem.reviewRequested",
  )!;
  const client = new TransactionClient();
  const store =
    adapter === "memory"
      ? createMemoryFailureStore({ source, store: h.app.persistence.store })
      : createDynamoFailureStore({ source, client, tableName: "test" });
  const service = createFailureService({
    source,
    store,
    repository: h.app.persistence.repository,
    dispatch: h.app.dispatch,
    clock: h.clock.now,
  });
  return {
    ...h,
    id,
    event,
    client,
    store,
    service,
    failureId: failedDeliveryId("deliverNotification", event.eventId),
  };
}
describe.each(["memory", "dynamo"] as const)("%s durable recovery", (adapter) => {
  it("recognizes an applied replay transaction after its successful response was lost", async () => {
    const h = await setup(adapter);
    await h.service.collect("deliverNotification", h.event);
    let lost = false;
    const store: FailureStore = {
      ...h.store,
      commit: async (version, record, replay) => {
        await h.store.commit(version, record, replay);
        if (replay && !lost) {
          lost = true;
          throw new JawStackRuntimeError("runtime.unavailable", "Response lost.");
        }
      },
    };
    const service = createFailureService({
      source,
      store,
      repository: h.app.persistence.repository,
      dispatch: h.app.dispatch,
      clock: h.clock.now,
    });
    const request = randomUUID();
    const outcome = await service.replay(h.failureId, fixtureAuth("editor_1"), request);
    expect(outcome.generation).toBe(1);
    expect((await h.store.get(h.failureId))!.recoveries).toHaveLength(1);
    expect((await service.replay(h.failureId, fixtureAuth("editor_1"), request)).generation).toBe(
      1,
    );
  });
  it("collects duplicates safely and resumes partially recorded work", async () => {
    const h = await setup(adapter);
    let crash = true;
    const interrupted = createFailureService({
      source,
      store: h.store,
      repository: h.app.persistence.repository,
      dispatch: h.app.dispatch,
      clock: h.clock.now,
      fault: (point) => {
        if (point === "afterRecord" && crash) {
          crash = false;
          throw new Error("process stopped");
        }
      },
    });
    await expect(interrupted.collect("deliverNotification", h.event)).rejects.toThrow(
      "process stopped",
    );
    expect((await h.store.get(h.failureId))!.collections[0]!.resolution).toBe("pending");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => h.service.collect("deliverNotification", h.event)),
    );
    for (const result of results) expect(result.status).toBe("failed");
    const record = (await h.store.get(h.failureId))!;
    expect(record.collections).toHaveLength(1);
    expect(record.version).toBe(2);
    expect(record.collections[0]!.reconciledAt).not.toBeNull();
    expect(
      JSON.stringify(await h.service.inspect(fixtureAuth("editor_1"), { id: h.failureId })),
    ).not.toContain("Body");
  });
  it("atomically queues one targeted replay and recovers an ambiguous CLI response", async () => {
    const h = await setup(adapter);
    await h.service.collect("deliverNotification", h.event);
    const request = randomUUID();
    let crash = true;
    const interrupted = createFailureService({
      source,
      store: h.store,
      repository: h.app.persistence.repository,
      dispatch: h.app.dispatch,
      clock: h.clock.now,
      fault: (point) => {
        if (point === "afterReplayCommit" && crash) {
          crash = false;
          throw new Error("CLI stopped");
        }
      },
    });
    await expect(interrupted.replay(h.failureId, fixtureAuth("editor_1"), request)).rejects.toThrow(
      "CLI stopped",
    );
    const result = await h.service.replay(h.failureId, fixtureAuth("editor_1"), request);
    expect(result).toMatchObject({
      generation: 1,
      status: "replayQueued",
      recoveries: [{ requestedBy: "editor_1", requestId: request }],
    });
    await h.service.replay(h.failureId, fixtureAuth("editor_2"), randomUUID());
    const record = (await h.store.get(h.failureId))!;
    expect(record.recoveries).toHaveLength(1);
    const replay = replayEnvelope(record, record.recoveries[0]!);
    expect(replay.eventId).not.toBe(h.event.eventId);
    expect(replay.correlationId).toBe(h.event.correlationId);
    expect(replay.payload.delivery).toMatchObject({
      originalEventId: h.event.eventId,
      consumer: "deliverNotification",
      generation: 1,
      failureId: h.failureId,
    });
    await expect(h.service.authorize("deliverNotification", replay)).resolves.toMatchObject({
      generation: 1,
    });
    const outboxes =
      adapter === "memory"
        ? h.app.persistence.store.outbox.filter((e) => e.eventId === replay.eventId)
        : [...h.client.items.values()].filter(
            (item) => item.itemKind?.S === "OUTBOX_EVENT" && item.eventId?.S === replay.eventId,
          );
    expect(outboxes).toHaveLength(1);
  });
  it("enforces three manually collected recovery cycles without resetting on marker TTL expiry", async () => {
    const h = await setup(adapter);
    await h.service.collect("deliverNotification", h.event);
    for (let generation = 1; generation <= 3; generation++) {
      await h.service.replay(h.failureId, fixtureAuth("editor_1"), randomUUID());
      const record = (await h.store.get(h.failureId))!;
      await h.service.collect(
        "deliverNotification",
        replayEnvelope(record, record.recoveries[generation - 1]!),
      );
    }
    h.clock.advance(workerMarkerTtlMs);
    await expect(
      h.service.replay(h.failureId, fixtureAuth("editor_1"), randomUUID()),
    ).rejects.toMatchObject({ code: "command.rejected" });
    const record = (await h.store.get(h.failureId))!;
    expect(record.recoveries).toHaveLength(3);
    expect(record.collections).toHaveLength(4);
  });
  it("rejects forged replay envelopes and preserves a newer successful resolution on late failure", async () => {
    const h = await setup(adapter);
    await h.service.collect("deliverNotification", h.event);
    await h.service.replay(h.failureId, fixtureAuth("editor_1"), randomUUID());
    const record = (await h.store.get(h.failureId))!;
    const replay = replayEnvelope(record, record.recoveries[0]!);
    for (const changed of [
      { ...replay, eventId: randomUUID() },
      { ...replay, source: "foreign" },
      { ...replay, payload: { ...replay.payload, dueAt: "2026-11-04T12:00:00.000Z" } },
      {
        ...replay,
        payload: {
          ...replay.payload,
          delivery: { ...(replay.payload.delivery as object), consumer: "materializeReview" },
        },
      },
    ])
      await expect(h.service.authorize("deliverNotification", changed)).rejects.toThrow();
    await h.service.complete("deliverNotification", replay);
    expect((await h.service.collect("deliverNotification", h.event)).status).toBe("resolved");
    expect((await h.service.collect("deliverNotification", replay)).status).toBe("resolved");
    await expect(
      h.service.replay(h.failureId, fixtureAuth("editor_1"), randomUUID()),
    ).rejects.toMatchObject({ code: "command.rejected" });
  });
});

describe("publication failure reconciliation", () => {
  const service = (
    h: Awaited<ReturnType<typeof publicationHarness>>,
    fault?: Parameters<typeof createFailureService>[0]["fault"],
  ) =>
    createFailureService({
      source,
      store: h.app.failureStore,
      repository: h.app.persistence.repository,
      dispatch: h.app.dispatch,
      clock: h.clock.now,
      ...(fault ? { fault } : {}),
    });
  const wire = (h: Awaited<ReturnType<typeof publicationHarness>>) =>
    h.app.persistence.store.outbox.find((e) => e.eventType === "contentItem.publicationRequested")!;
  it("stalls an unclaimed exhausted delivery without inventing an attempt, then editor retry publishes the same intent", async () => {
    const h = await publicationHarness();
    const original = wire(h);
    const summary = await service(h).collect("publishContent", original);
    expect(summary.status).toBe("failed");
    expect((await h.current()).state.publication).toMatchObject({
      phase: "stalled",
      attemptsInGeneration: 0,
      lastAttempt: null,
      deliveryFailure: { failureId: summary.id },
    });
    await expect(
      service(h).replay(summary.id, fixtureAuth("editor_1"), randomUUID()),
    ).rejects.toMatchObject({ code: "command.rejected" });
    const row = await h.current();
    expect(
      (
        await h.run("retryPublication", {
          expectedVersion: row.version,
          publicationId: h.intent.publicationId,
          generation: 1,
        })
      ).ok,
    ).toBe(true);
    await h.app.drainUntilIdle();
    expect((await h.current()).state).toMatchObject({
      status: "published",
      publication: { generation: 2, intent: h.intent, deliveryFailure: null },
    });
    const before = await h.current();
    await service(h).collect("publishContent", original);
    expect(await h.current()).toEqual(before);
  });
  it("defers a live claim, closes an expired attempt, and resumes a crash after domain reconciliation", async () => {
    const h = await publicationHarness();
    const original = wire(h);
    await expect(
      h.publisher({
        fault: (point) => {
          if (point === "afterObjectWrite") throw new SimulatedPublicationCrash();
        },
      })(h.event()),
    ).rejects.toThrow();
    await expect(service(h).collect("publishContent", original)).rejects.toMatchObject({
      code: "resource.conflict",
    });
    const id = failedDeliveryId("publishContent", original.eventId);
    expect((await h.app.failureStore.get(id))!.collections[0]!.resolution).toBe("pending");
    h.clock.advance(90_000);
    await expect(
      service(h, (point) => {
        if (point === "afterReconcile") throw new Error("collector stopped");
      }).collect("publishContent", original),
    ).rejects.toThrow("collector stopped");
    const reconciled = await h.current();
    expect(reconciled.state.publication).toMatchObject({
      phase: "stalled",
      claim: null,
      lastAttempt: { status: "expired" },
    });
    expect((await h.app.failureStore.get(id))!.collections[0]!.resolution).toBe("pending");
    expect((await service(h).collect("publishContent", original)).status).toBe("failed");
    expect(await h.current()).toEqual(reconciled);
    expect(
      h.app.persistence.store.outbox.filter((e) => e.eventType === "contentItem.publicationFailed"),
    ).toHaveLength(1);
  });
  it("cannot replace a newer claim generation or completed artifact with a late DLQ result", async () => {
    for (const complete of [false, true]) {
      const h = await publicationHarness();
      if (complete) await h.publisher()(h.event());
      else {
        await expect(
          h.publisher({
            fault: (point) => {
              if (point === "afterClaim") throw new SimulatedPublicationCrash();
            },
          })(h.event()),
        ).rejects.toThrow();
        h.clock.advance(90_000);
        const row = await h.current();
        expect(
          (
            await h.run("retryPublication", {
              expectedVersion: row.version,
              publicationId: h.intent.publicationId,
              generation: 1,
            })
          ).ok,
        ).toBe(true);
      }
      const before = await h.current();
      expect((await service(h).collect("publishContent", wire(h))).status).toBe("resolved");
      expect(await h.current()).toEqual(before);
    }
  });
});

describe("memory terminal/replay walkthrough and safety", () => {
  it("collects terminal notification work, replays only that consumer, and deduplicates after marker expiry", async () => {
    const h = await setup();
    const deliver = vi
      .spyOn(h.app.notifications, "deliver")
      .mockRejectedValue(new Error("private provider detail"));
    await h.app.drainUntilIdle();
    h.clock.advance(1000);
    await h.app.drainUntilIdle();
    h.clock.advance(2000);
    await h.app.drainUntilIdle();
    const id = failedDeliveryId("deliverNotification", h.event.eventId);
    expect((await h.app.failureStore.get(id))!.collections[0]!.resolution).toBe("notApplicable");
    expect(h.app.pump.inspect().jobs).toHaveLength(0);
    const review = (await h.current(h.id)).state.review!;
    const projected = await h.app.persistence.repository.getState("reviewTask", review.reviewId);
    deliver.mockRestore();
    await h.app.failures.replay(id, fixtureAuth("editor_1"), randomUUID());
    await h.app.drainUntilIdle();
    expect((await h.app.failureStore.get(id))!.resolvedGeneration).toBe(1);
    expect(h.app.notifications.deliveries.size).toBe(1);
    expect(await h.app.persistence.repository.getState("reviewTask", review.reviewId)).toEqual(
      projected,
    );
    h.clock.advance(workerMarkerTtlMs);
    const freshPump = createMemoryPump({
      outbox: () => h.app.persistence.store.outbox,
      workers: h.app.workers,
      failures: h.app.failures,
      clock: h.clock.now,
    });
    for (let n = 0; n < 3; n++) await freshPump.drain();
    expect(h.app.notifications.deliveries.size).toBe(1);
    expect((await h.app.failureStore.get(id))!.recoveries).toHaveLength(1);
  });
  it("bounds memory retention without evicting deduplication or accepting arbitrary envelopes", async () => {
    const h = await setup();
    const store = createMemoryFailureStore({ source, maxRecords: 1 });
    const failures = createFailureService({
      source,
      store,
      repository: h.app.persistence.repository,
      dispatch: h.app.dispatch,
      clock: h.clock.now,
    });
    await failures.collect("deliverNotification", h.event);
    await failures.collect("deliverNotification", h.event);
    await expect(
      failures.collect("deliverNotification", { ...h.event, eventId: randomUUID() }),
    ).rejects.toThrow();
    for (const bad of [
      { ...h.event, source: "foreign" },
      { ...h.event, payload: { arbitrary: true } },
      { ...h.event, eventType: "contentItem.snapshotApplied" },
    ])
      await expect(failures.collect("deliverNotification", bad)).rejects.toThrow();
    await expect(failures.collect("arbitrary" as "deliverNotification", h.event)).rejects.toThrow();
    expect(store.records.size).toBe(1);
    await expect(
      failures.inspect({ ...fixtureAuth("author_1"), roles: ["editor"] }),
    ).rejects.toMatchObject({ code: "auth.forbidden" });
    await expect(
      failures.replay(h.failureId, fixtureAuth("author_1"), randomUUID()),
    ).rejects.toMatchObject({ code: "auth.forbidden" });
  });
  it("rolls replay state back with an outbox collision in the same DynamoDB transaction", async () => {
    const h = await setup("dynamo");
    await h.service.collect("deliverNotification", h.event);
    const old = (await h.store.get(h.failureId))!;
    const recovery = {
      generation: 1,
      eventId: randomUUID(),
      requestedAt: h.clock.now().toISOString(),
      requestedBy: "editor_1" as const,
      requestId: randomUUID(),
    };
    const next = { ...old, version: old.version + 1, recoveries: [recovery] };
    const replay = replayEnvelope(next, recovery);
    const collision = toOutboxEventItem(replay);
    h.client.items.set(itemKey(collision), collision);
    const before = structuredClone(h.client.items);
    await expect(h.store.commit(old.version, next, replay)).rejects.toMatchObject({
      code: "resource.conflict",
    });
    expect(h.client.items).toEqual(before);
    expect((await h.store.get(h.failureId))!.recoveries).toHaveLength(0);
    expect(failureKey(h.failureId).PK).toContain(h.failureId);
  });
  it("rejects CLI payload/queue/consumer overrides and invalid editor/limit/IDs", () => {
    const id = "a".repeat(64);
    expect(parseJobsArgs(["replay", id, "--actor", "editor_1"]).id).toBe(id);
    for (const args of [
      ["inspect", "--actor", "author_1"],
      ["replay", id, "--actor", "editor_1", "--queue-url", "https://evil"],
      ["replay", id, "--actor", "editor_1", "--consumer", "publishContent"],
      ["replay", id, "--actor", "editor_1", "--payload", "{}"],
      ["inspect", "--actor", "editor_1", "--limit", "101"],
      ["replay", "not-an-id", "--actor", "editor_1"],
    ])
      expect(() => parseJobsArgs(args)).toThrow();
  });
});
