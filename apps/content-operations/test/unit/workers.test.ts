import { describe, expect, it, vi } from "vitest";
import {
  createManifest,
  JawStackRuntimeError,
  type CommandRequest,
  type JawStackEvent,
} from "@jawstack/core";
import { createFixtureClock, createMemoryRuntime } from "../../src/application/runtime";
import { createContentWorkers } from "../../src/application/workers";
import { createMemoryPump, workerMarkerTtlMs } from "../../src/application/pump";
import { renderNotification } from "../../src/application/notifications";
import { assetJanitorIdentity, createContentOperationsResources } from "../../src/domain/resources";
import { contentWorkers } from "../../src/domain/subscriptions";
import { parseContentEvent } from "../../src/shared/events";
import { fixtureAuth } from "../../src/shared/identities";
import type { ContentState, ReviewTaskState } from "../../src/shared/contracts";
import type { AssetSlot } from "../../src/shared/assets";

const contentId = "00000000-0000-4000-8000-000000000001";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1kAAAAASUVORK5CYII=",
  "base64",
);
async function harness() {
  const clock = createFixtureClock("2026-10-31T12:00:00.000Z");
  const app = createMemoryRuntime({ clock: clock.now });
  let sequence = 0;
  const run = (commandName: string, input: unknown, editor = false) =>
    app.dispatch(
      {
        resourceType: "contentItem",
        resourceId: contentId,
        commandName,
        input,
        idempotencyKey: `user:${++sequence}`,
        requestContext: {},
      },
      fixtureAuth(editor ? "editor_1" : "author_1"),
    );
  const state = async () =>
    (await app.persistence.repository.getState<ContentState>("contentItem", contentId))!;
  const event = (type: string) =>
    [...app.persistence.store.outbox].reverse().find((e) => e.eventType === type)!;
  expect((await run("create", { title: "Editorial workflow", body: "Body" })).ok).toBe(true);
  const submit = async () => {
    expect(
      (
        await run("submit", {
          expectedVersion: (await state()).version,
          assignedEditorId: "editor_1",
          dueAt: "2026-11-01T12:00:00.000Z",
        })
      ).ok,
    ).toBe(true);
    return event("contentItem.reviewRequested");
  };
  const decide = async () => {
    const previous = await state();
    expect(
      (
        await run(
          "approve",
          {
            expectedVersion: previous.version,
            reviewId: previous.state.review!.reviewId,
            revisionId: previous.state.revisionId,
            note: "Approved",
          },
          true,
        )
      ).ok,
    ).toBe(true);
    return event("contentItem.reviewDecided");
  };
  const register = async () => {
    expect(
      (
        await run("registerAsset", {
          expectedVersion: (await state()).version,
          filename: "photo.png",
          mediaType: "image/png",
          expectedSize: png.length,
        })
      ).ok,
    ).toBe(true);
    return (await state()).state.attachments.at(-1)!;
  };
  return { app, clock, run, state, event, submit, decide, register };
}

describe("shared application workers", () => {
  it("sanitizes unexpected repository and sink failures at the shared handler boundary", async () => {
    const h = await harness();
    const requested = await h.submit();
    const workers = createContentWorkers({
      dispatch: h.app.dispatch,
      repository: {
        getState: async () => {
          throw new Error("secret database diagnostics");
        },
      },
      notifications: {
        ...h.app.notifications,
        deliver: async () => {
          throw new Error("secret sink diagnostics");
        },
      },
    });
    for (const name of ["materializeReview", "deliverNotification"] as const)
      await expect(workers.handle(name, requested)).rejects.toMatchObject({
        code: "runtime.unavailable",
        message: "Application worker dependency failed.",
      });
  });

  it("routes changes-requested notifications and expired-asset tombstones from implemented facts", async () => {
    const h = await harness();
    await h.submit();
    const previous = await h.state();
    expect(
      (
        await h.run(
          "requestChanges",
          {
            expectedVersion: previous.version,
            reviewId: previous.state.review!.reviewId,
            revisionId: previous.state.revisionId,
            note: "Please revise",
          },
          true,
        )
      ).ok,
    ).toBe(true);
    const decided = h.event("contentItem.reviewDecided");
    await h.app.workers.handle("materializeReview", decided);
    await h.app.workers.handle("deliverNotification", decided);
    expect((await h.app.notifications.query({ recipientId: "author_1" })).items).toMatchObject([
      { data: { template: "review-changes-requested.v1" } },
    ]);
    const slot = await h.register();
    const registered = h.event("contentItem.assetRegistered");
    h.clock.advance(60 * 60 * 1000);
    expect(
      (
        await h.app.dispatch(
          {
            resourceType: "contentItem",
            resourceId: contentId,
            commandName: "expireAsset",
            input: { expectedVersion: (await h.state()).version, assetId: slot.assetId },
            idempotencyKey: "expire",
            requestContext: {},
          },
          {
            subject: assetJanitorIdentity.subject,
            roles: [assetJanitorIdentity.role],
            mode: "test",
            claims: {},
          },
        )
      ).ok,
    ).toBe(true);
    await h.app.workers.handle("materializeAsset", h.event("contentItem.assetExpired"));
    expect(await h.app.workers.handle("materializeAsset", registered)).toBe("ignored");
    expect(
      (await h.app.persistence.repository.getState<AssetSlot>("asset", slot.assetId))?.state.status,
    ).toBe("expired");
  });

  it("preserves notification projections when materializers and the sink commit concurrently", async () => {
    const h = await harness();
    const requested = await h.submit();
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        await Promise.all(
          h.app.workers
            .subscribers(requested.eventType)
            .map((name) => h.app.workers.handle(name, requested)),
        );
      }),
    );
    expect(
      (
        await h.app.persistence.repository.queryProjection({
          projectionName: "contentItem.notifications",
          limit: 50,
        })
      ).items,
    ).toHaveLength(1);
    expect(await h.app.persistence.repository.listProjection("reviewTask.pending")).toHaveLength(1);
    expect(h.app.notifications.operations.size).toBe(1);
    expect(
      h.app.persistence.store.outbox.filter(
        (event) => event.eventType === "reviewTask.snapshotApplied",
      ),
    ).toHaveLength(1);
  });

  it("materializes a completed review before its opening fact without restoring pending state", async () => {
    const h = await harness();
    const requested = await h.submit();
    const decided = await h.decide();
    expect(await h.app.workers.handle("materializeReview", decided)).toBe("applied");
    expect(await h.app.workers.handle("materializeReview", requested)).toBe("ignored");
    const snapshot = decided.payload as ReviewTaskState;
    expect(
      await h.app.persistence.repository.getState("reviewTask", snapshot.reviewId),
    ).toMatchObject({
      version: 1,
      state: { status: "approved", sourceVersion: snapshot.sourceVersion },
    });
    expect(await h.app.persistence.repository.listProjection("reviewTask.pending")).toEqual([]);
    const output = h.event("reviewTask.snapshotApplied");
    expect(output).toMatchObject({
      correlationId: decided.correlationId,
      causationId: decided.eventId,
      actor: { subject: "review_projector" },
    });
    expect(h.app.workers.subscribers(output.eventType)).toEqual([]);
  });

  it("upserts terminal asset tombstones before registration/readiness, then ignores late facts", async () => {
    const h = await harness();
    const slot = await h.register();
    const opening = h.event("contentItem.assetRegistered");
    await h.app.upload({
      contentId,
      assetId: slot.assetId,
      identity: fixtureAuth("author_1"),
      body: png,
    });
    const ready = h.event("contentItem.assetReady");
    expect(
      (
        await h.run("removeAsset", {
          expectedVersion: (await h.state()).version,
          assetId: slot.assetId,
        })
      ).ok,
    ).toBe(true);
    const removed = h.event("contentItem.assetRemoved");
    expect(await h.app.workers.handle("materializeAsset", removed)).toBe("applied");
    expect(await h.app.workers.handle("materializeAsset", ready)).toBe("ignored");
    expect(await h.app.workers.handle("materializeAsset", opening)).toBe("ignored");
    expect(await h.app.persistence.repository.getState("asset", slot.assetId)).toMatchObject({
      version: 1,
      state: { status: "removed" },
    });
    expect(
      await h.app.persistence.repository.listProjection(`asset.content.${contentId}`),
    ).toMatchObject([{ data: { status: "removed" } }]);
    expect(h.app.workers.subscribers("asset.snapshotApplied")).toEqual([]);
    expect(h.event("asset.snapshotApplied")).toMatchObject({
      correlationId: removed.correlationId,
      causationId: removed.eventId,
    });
  });

  it("converges concurrent creates and updates on one snapshot version/activity", async () => {
    const h = await harness();
    const requested = await h.submit();
    await Promise.all(
      Array.from({ length: 8 }, () => h.app.workers.handle("materializeReview", requested)),
    );
    const decided = await h.decide();
    await Promise.all(
      Array.from({ length: 8 }, () => h.app.workers.handle("materializeReview", decided)),
    );
    const reviewId = (requested.payload as ReviewTaskState).reviewId;
    expect(await h.app.persistence.repository.getState("reviewTask", reviewId)).toMatchObject({
      version: 2,
      state: { status: "approved" },
    });
    expect(await h.app.persistence.repository.getActivity("reviewTask", reviewId)).toHaveLength(2);
  });

  it.each([
    { source: "other-application" },
    { schemaVersion: 2 },
    { envelopeVersion: 2 },
    { resourceType: "asset" },
    { resourceId: "00000000-0000-4000-8000-000000000999" },
    { tenantId: "another-tenant" },
    { eventId: "bad\n" },
    { correlationId: "" },
    { payload: { status: "pending" } },
  ])(
    "rejects invalid source/envelope/payload before dispatch or sink effects: %j",
    async (override) => {
      const h = await harness();
      const fact = await h.submit();
      await expect(
        h.app.workers.handle("materializeReview", { ...fact, ...override }),
      ).rejects.toMatchObject({ code: "command.validation" });
      expect(await h.app.persistence.repository.listProjection("reviewTask.list")).toEqual([]);
      expect((await h.app.notifications.query()).items).toEqual([]);
    },
  );

  it("rejects wrong subscriptions, equal-version rewrites and invalid stored materializations", async () => {
    const h = await harness();
    const requested = await h.submit();
    await expect(h.app.workers.handle("materializeAsset", requested)).rejects.toMatchObject({
      code: "command.rejected",
    });
    await h.app.workers.handle("materializeReview", requested);
    const snapshot = requested.payload as ReviewTaskState;
    const rewritten = { ...snapshot, submitted: { ...snapshot.submitted, title: "Forged title" } };
    await expect(
      h.app.workers.handle("materializeReview", { ...requested, payload: rewritten }),
    ).rejects.toMatchObject({ code: "resource.conflict" });
    const key = `reviewTask\0${snapshot.reviewId}`;
    const stored = h.app.persistence.store.resources.get(key)!;
    h.app.persistence.store.resources.set(key, { ...stored, state: {} });
    await expect(h.app.workers.handle("materializeReview", requested)).rejects.toMatchObject({
      code: "resource.invalid_state",
    });
  });

  it("refreshes after a version conflict, and bounds unresolved optimistic conflicts to three attempts", async () => {
    const h = await harness();
    const event = await h.submit();
    const requests: CommandRequest[] = [];
    let conflicts = 1;
    const workers = createContentWorkers({
      repository: h.app.persistence.repository,
      notifications: h.app.notifications,
      clock: h.clock.now,
      dispatch: async (request, auth) => {
        requests.push(request);
        if (conflicts-- > 0)
          return {
            ok: false,
            error: { code: "resource.conflict", message: "Injected conflict" },
            meta: { requestId: "test", correlationId: "test" },
          };
        return h.app.dispatch(request, auth);
      },
    });
    expect(await workers.handle("materializeReview", event)).toBe("applied");
    expect(requests).toHaveLength(2);
    const decided = await h.decide();
    conflicts = 10;
    requests.length = 0;
    await expect(workers.handle("materializeReview", decided)).rejects.toMatchObject({
      code: "resource.conflict",
    });
    expect(requests).toHaveLength(3);
  });

  it("supports an explicit stage source and never advertises unimplemented subscriptions", async () => {
    const clock = createFixtureClock("2026-10-31T12:00:00.000Z");
    const app = createMemoryRuntime({ clock: clock.now, source: "content-operations.stage" });
    const result = await app.dispatch(
      {
        resourceType: "contentItem",
        commandName: "create",
        input: { title: "Stage", body: "Body" },
        idempotencyKey: "create",
        requestContext: {},
      },
      fixtureAuth("author_1"),
    );
    expect(result.ok).toBe(true);
    expect(app.persistence.store.outbox[0]?.source).toBe("content-operations.stage");
    const manifest = createManifest({
      appName: "content-operations",
      stage: "test",
      resources: createContentOperationsResources(),
      auth: { mode: "dev", provider: "fixtures" },
      costProfile: {},
    });
    expect(manifest.resources.flatMap((r) => r.workers).map((w) => w.name)).toEqual(
      contentWorkers.map((w) => w.name),
    );
    expect(
      contentWorkers
        .flatMap((w) => w.eventTypes)
        .some((type) => /reminder|snapshotApplied/.test(type)),
    ).toBe(false);
  });
});

describe("memory workflow and pump", () => {
  it("processes healthy work beside an invalid source while retaining bounded retries for the poison event", async () => {
    const h = await harness();
    const requested = await h.submit();
    const outbox = [{ ...requested, eventId: "bad-source", source: "not-this-app" }, requested];
    const pump = createMemoryPump({
      outbox: () => outbox,
      workers: h.app.workers,
      clock: h.clock.now,
    });
    expect(await pump.drain()).toMatchObject({ succeeded: 2, retried: 2, pending: 2 });
    expect((await h.app.notifications.query()).items).toHaveLength(1);
    expect(await h.app.persistence.repository.listProjection("reviewTask.pending")).toHaveLength(1);
    h.clock.advance(1000);
    await pump.drain();
    h.clock.advance(2000);
    expect(await pump.drain()).toMatchObject({ failed: 2, terminal: 2, pending: 0 });
  });

  it("backpressures a whole fan-out even when one unused slot remains", async () => {
    const h = await harness();
    const slot = await h.register();
    const outbox = [h.event("contentItem.assetRegistered")];
    const pump = createMemoryPump({
      outbox: () => outbox,
      workers: {
        subscribers: h.app.workers.subscribers,
        handle: async () => {
          throw new Error("injected");
        },
      },
      clock: h.clock.now,
      maxJobs: 2,
    });
    await pump.drain();
    h.clock.advance(1000);
    await pump.drain();
    h.clock.advance(2000);
    await pump.drain();
    expect(
      (
        await h.run("removeAsset", {
          expectedVersion: (await h.state()).version,
          assetId: slot.assetId,
        })
      ).ok,
    ).toBe(true);
    outbox.push(await h.submit());
    expect(await pump.drain()).toMatchObject({
      scanned: 0,
      attempted: 0,
      terminal: 1,
      backpressured: true,
    });
    expect(pump.inspect().cursor).toBe(1);
  });

  it("drains a draft/upload/review workflow into related resources and a visible notification sink without loops", async () => {
    const h = await harness();
    const asset = await h.register();
    await h.app.upload({
      contentId,
      assetId: asset.assetId,
      identity: fixtureAuth("author_1"),
      body: png,
    });
    await h.submit();
    await h.decide();
    await h.app.drainUntilIdle();
    expect(
      (await h.app.persistence.repository.getState<AssetSlot>("asset", asset.assetId))?.state
        .status,
    ).toBe("ready");
    expect(
      (
        await h.app.persistence.repository.getState<ReviewTaskState>(
          "reviewTask",
          (await h.state()).state.review!.reviewId,
        )
      )?.state.status,
    ).toBe("approved");
    const delivered = await h.app.notifications.query();
    expect(delivered.items).toHaveLength(2);
    expect(delivered.items.map((row) => row.data.recipientId).sort()).toEqual([
      "author_1",
      "editor_1",
    ]);
    expect(
      (
        await h.app.persistence.repository.queryProjection({
          projectionName: "contentItem.notifications",
          limit: 50,
        })
      ).items,
    ).toEqual(delivered.items);
    const length = h.app.persistence.store.outbox.length;
    expect(await h.app.pump.drain()).toMatchObject({
      scanned: 0,
      attempted: 0,
      pending: 0,
      terminal: 0,
      hasMore: false,
    });
    expect(h.app.persistence.store.outbox).toHaveLength(length);
  });

  it("keeps one sink delivery under concurrent drains, redelivery, marker expiry, and replay transport IDs", async () => {
    const h = await harness();
    const requested = await h.submit();
    await Promise.all([h.app.pump.drain(), h.app.pump.drain(), h.app.pump.drain()]);
    h.app.persistence.store.outbox.push(structuredClone(requested));
    await h.app.drainUntilIdle();
    const first = (await h.app.notifications.query()).items[0]!.data;
    h.clock.advance(workerMarkerTtlMs);
    h.app.persistence.store.outbox.push(structuredClone(requested));
    const replay = {
      ...requested,
      eventId: "replay_transport",
      occurredAt: h.clock.now().toISOString(),
      payload: {
        ...(requested.payload as object),
        delivery: { originalEventId: requested.eventId, generation: 1 },
      },
    };
    h.app.persistence.store.outbox.push(replay);
    await h.app.drainUntilIdle();
    expect((await h.app.notifications.query()).items.map((row) => row.data)).toEqual([first]);
    expect(
      h.app.persistence.store.outbox.filter(
        (event) => event.eventType === "reviewTask.snapshotApplied",
      ),
    ).toHaveLength(1);
  });

  it("converges after a sink commit but before a transport marker, with bounded backoff and sanitized state", async () => {
    const h = await harness();
    const requested = await h.submit();
    let injected = true;
    const workers = {
      ...h.app.workers,
      handle: async (...args: Parameters<typeof h.app.workers.handle>) => {
        const value = await h.app.workers.handle(...args);
        if (args[0] === "deliverNotification" && injected) {
          injected = false;
          throw new Error("sensitive provider details");
        }
        return value;
      },
    };
    const pump = createMemoryPump({
      outbox: () => h.app.persistence.store.outbox,
      workers,
      clock: h.clock.now,
    });
    expect(await pump.drain()).toMatchObject({ retried: 1, pending: 1 });
    expect((await h.app.notifications.query()).items).toHaveLength(1);
    expect(JSON.stringify(pump.inspect())).not.toContain("sensitive");
    expect(await pump.drain()).toMatchObject({ attempted: 0, pending: 1 });
    h.clock.advance(1000);
    expect(await pump.drain()).toMatchObject({ succeeded: 1, pending: 0 });
    expect((await h.app.notifications.query()).items).toHaveLength(1);
    expect(
      await h.app.notifications.get(
        renderNotification(parseContentEvent(requested), h.clock.now()).deliveryId,
      ),
    ).toBeDefined();
  });

  it("stops after three failures, keeps terminal jobs, and backpressures without advancing past unadmitted events", async () => {
    const h = await harness();
    const event = await h.submit();
    const outbox: JawStackEvent[] = [event];
    const handle = vi.fn(async () => {
      throw new JawStackRuntimeError("runtime.unavailable", "secret raw failure");
    });
    const pump = createMemoryPump({
      outbox: () => outbox,
      workers: { subscribers: h.app.workers.subscribers, handle },
      clock: h.clock.now,
      maxJobs: 2,
    });
    expect(await pump.drain()).toMatchObject({ attempted: 2, retried: 2 });
    h.clock.advance(1000);
    expect(await pump.drain()).toMatchObject({ attempted: 2, retried: 2 });
    h.clock.advance(2000);
    expect(await pump.drain()).toMatchObject({ attempted: 2, failed: 2, terminal: 2 });
    outbox.push({ ...event, eventId: "next_event" });
    expect(await pump.drain()).toMatchObject({ scanned: 0, attempted: 0, backpressured: true });
    expect(pump.inspect().cursor).toBe(1);
    expect(pump.inspect().jobs.every((job) => job.status === "failed" && job.attempts === 3)).toBe(
      true,
    );
    expect(JSON.stringify(pump.inspect())).not.toContain("secret");
    expect(handle).toHaveBeenCalledTimes(6);
  });

  it("bounds work per drain, rejects event-ID rewrites, and exposes clock/drain budget guards", async () => {
    const h = await harness();
    const requested = await h.submit();
    const outbox = [requested];
    const pump = createMemoryPump({
      outbox: () => outbox,
      workers: h.app.workers,
      clock: h.clock.now,
      maxMarkers: 1,
    });
    expect(await pump.drain(1)).toMatchObject({ scanned: 1, attempted: 1, hasMore: true });
    await pump.drain(1);
    expect(pump.inspect().markers).toBe(1);
    outbox.push({ ...requested, correlationId: "changed_correlation" });
    await expect(pump.drain()).rejects.toMatchObject({ code: "resource.conflict" });
    await expect(pump.drain(101)).rejects.toThrow();
    expect(() =>
      createMemoryPump({ outbox: () => [], workers: h.app.workers, maxJobs: 0 }),
    ).toThrow();
    expect(() => h.clock.advance(-1)).toThrow();
    const copy = h.clock.now();
    copy.setUTCFullYear(2040);
    expect(h.clock.now().getUTCFullYear()).toBe(2026);
    await expect(h.app.drainUntilIdle(0)).rejects.toThrow();
  });
});
