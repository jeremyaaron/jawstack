import { describe, expect, it, vi } from "vitest";
import { createContentJobs } from "../../src/application/jobs";
import { createContentDispatch } from "../../src/application/dispatch";
import {
  createMemoryJobStore,
  type JobName,
  type JobRecord,
} from "../../src/application/job-store";
import { dueWorkerIdentity } from "../../src/domain/publication-commands";
import { editorialHarness, png } from "../support/editorial";

describe("bounded due work", () => {
  it("fences an expired tick that resumes after its successor completed the pass", async () => {
    const h = editorialHarness();
    const id = await h.create("review");
    h.clock.advance(3_600_000);
    const store = createMemoryJobStore();
    let reached!: () => void;
    let resume!: () => void;
    const ready = new Promise<void>((done) => {
      reached = done;
    });
    const pause = new Promise<void>((done) => {
      resume = done;
    });
    const repo = h.app.persistence.repository;
    const firstRepo = {
      queryProjection: repo.queryProjection.bind(repo),
      queryActivity: repo.queryActivity.bind(repo),
      getState: async (type: string, key: string) => {
        const row = await repo.getState(type, key);
        reached();
        await pause;
        return row;
      },
    };
    const options = {
      repository: repo,
      dispatch: h.app.dispatch,
      objects: h.app.objects,
      store,
      clock: h.clock.now,
    };
    const first = createContentJobs({ ...options, repository: firstRepo }).tick("dueReview");
    const rejected = expect(first).rejects.toMatchObject({ code: "resource.conflict" });
    await ready;
    h.clock.advance(30_000);
    expect((await createContentJobs(options).tick("dueReview")).succeeded).toBe(1);
    resume();
    await rejected;
    expect((await h.current(id)).state.review!.lastReminderDay).toBe("2026-10-31");
    expect(
      h.app.persistence.store.outbox.filter(
        (e) => e.eventType === "contentItem.reviewReminderRecorded",
      ),
    ).toHaveLength(1);
  });
  it("keeps an unattempted candidate when authority loading exhausts the time budget", async () => {
    const h = editorialHarness();
    await h.create("review");
    h.clock.advance(3_600_000);
    let elapsed = 0;
    const records = new Map<JobName, JobRecord>();
    const repo = h.app.persistence.repository;
    const jobs = createContentJobs({
      repository: {
        queryProjection: repo.queryProjection.bind(repo),
        queryActivity: repo.queryActivity.bind(repo),
        getState: async (type, id) => {
          elapsed = 20_000;
          return repo.getState(type, id);
        },
      },
      dispatch: h.app.dispatch,
      objects: h.app.objects,
      store: createMemoryJobStore(records),
      clock: h.clock.now,
      monotonic: () => elapsed,
    });
    expect(await jobs.tick("dueReview")).toMatchObject({
      status: "yielded",
      failures: [],
      succeeded: 0,
    });
    expect(records.get("dueReview")!.progress.cursor).toBeNull();
  });
  it("does not run early; overlapping/repeated ticks enqueue once and the memory pump publishes", async () => {
    const h = editorialHarness();
    const id = await h.create("scheduled");
    expect((await h.app.jobs.tick("duePublication")).succeeded).toBe(0);
    h.clock.advance(3_600_000);
    const results = await Promise.all([
      h.app.jobs.tick("duePublication"),
      h.app.jobs.tick("duePublication"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["busy", "completed"]);
    expect((await h.current(id)).state.status).toBe("publishing");
    await h.app.jobs.tick("duePublication");
    await h.app.drainUntilIdle();
    expect((await h.current(id)).state.status).toBe("published");
    expect(
      h.app.persistence.store.outbox.filter(
        (e) => e.eventType === "contentItem.publicationRequested",
      ),
    ).toHaveLength(1);
  });

  it("records one reminder per UTC day atomically and delivers it to the assigned editor", async () => {
    const h = editorialHarness();
    const id = await h.create("review");
    h.clock.advance(3_600_000);
    expect((await h.app.jobs.tick("dueReview")).succeeded).toBe(1);
    const row = await h.current(id);
    const revision = row.state.revisionId;
    expect(row.state.review!.lastReminderDay).toBe("2026-10-31");
    await h.app.jobs.tick("dueReview");
    await h.app.drainUntilIdle();
    expect(
      [...h.app.notifications.deliveries.values()].filter(
        (n) => n.template === "review-reminder.v1",
      ),
    ).toMatchObject([{ recipientId: "editor_1", reviewId: row.state.review!.reviewId }]);
    h.clock.advance(11 * 3_600_000);
    expect((await h.app.jobs.tick("dueReview")).succeeded).toBe(1);
    expect((await h.current(id)).state).toMatchObject({
      revisionId: revision,
      review: { lastReminderDay: "2026-11-01" },
    });
    await h.app.drainUntilIdle();
    expect(
      [...h.app.notifications.deliveries.values()].filter(
        (n) => n.template === "review-reminder.v1",
      ),
    ).toHaveLength(2);
    const clockBack = createContentDispatch({
      persistence: h.app.persistence.factory,
      clock: () => new Date("2026-10-31T23:59:59.999Z"),
    });
    const latest = await h.current(id);
    expect(
      await clockBack(
        {
          resourceType: "contentItem",
          resourceId: id,
          commandName: "recordReviewReminder",
          input: {
            expectedVersion: latest.version,
            reviewId: latest.state.review!.reviewId,
            revisionId: revision,
          },
          idempotencyKey: "regressed-clock",
          requestContext: {},
        },
        {
          subject: dueWorkerIdentity.subject,
          roles: [dueWorkerIdentity.role],
          claims: {},
          mode: "test",
        },
      ),
    ).toMatchObject({ ok: false, error: { code: "command.rejected" } });
  });

  it("checkpoints past a failed oldest item, keeps a fixed cutoff on restart, and tolerates deleted boundaries", async () => {
    const h = editorialHarness();
    for (let i = 0; i < 3; i++) await h.create("review");
    const later = await h.create("review", 2);
    h.clock.advance(3_600_000);
    const ordered = (
      await h.app.persistence.repository.queryProjection({
        projectionName: "contentItem.dueReview",
      })
    ).items;
    const first = ordered[0]!.itemId;
    const records = new Map<JobName, JobRecord>();
    const store = createMemoryJobStore(records);
    const dispatch = vi.fn(h.app.dispatch).mockImplementation(async (request, identity) => {
      if (request.resourceId === first) throw new Error("sensitive failing oldest item");
      return h.app.dispatch(request, identity);
    });
    const compose = () =>
      createContentJobs({
        repository: h.app.persistence.repository,
        dispatch,
        objects: h.app.objects,
        store,
        clock: h.clock.now,
      });
    expect(await compose().tick("dueReview", { maxItems: 1 })).toMatchObject({
      status: "yielded",
      failures: [{ itemId: first, code: "runtime.unavailable" }],
    });
    const cutoff = records.get("dueReview")!.progress.passCutoff;
    const old = await h.current(first);
    h.check(await h.run(first, "reopenDraft", { expectedVersion: old.version }));
    h.clock.advance(2 * 3_600_000);
    expect((await compose().tick("dueReview", { maxItems: 1 })).succeeded).toBe(1);
    expect(records.get("dueReview")!.progress.passCutoff).toBe(cutoff);
    expect((await compose().tick("dueReview")).succeeded).toBe(1);
    expect((await h.current(later)).state.review!.lastReminderDay).toBeNull();
    expect((await compose().tick("dueReview")).succeeded).toBe(1);
  });

  it("ignores stale generation/revision candidates instead of publishing a rescheduled item", async () => {
    const h = editorialHarness();
    const id = await h.create("scheduled");
    const stale = await h.app.persistence.repository.queryProjection({
      projectionName: "contentItem.duePublication",
    });
    const row = await h.current(id);
    h.check(
      await h.run(
        id,
        "reschedule",
        {
          expectedVersion: row.version,
          reviewId: row.state.approval!.reviewId,
          revisionId: row.state.revisionId,
          scheduleGeneration: row.state.schedule!.generation,
          scheduledAt: "2026-10-31T13:00:00.000Z",
          timeZone: "UTC",
        },
        true,
      ),
    );
    h.clock.advance(3_600_000);
    const jobs = createContentJobs({
      repository: {
        getState: h.app.persistence.repository.getState.bind(h.app.persistence.repository),
        queryActivity: h.app.persistence.repository.queryActivity.bind(
          h.app.persistence.repository,
        ),
        queryProjection: async () => stale,
      },
      dispatch: h.app.dispatch,
      objects: h.app.objects,
      store: createMemoryJobStore(),
      clock: h.clock.now,
    });
    expect(await jobs.tick("duePublication")).toMatchObject({ ignored: 1, succeeded: 0 });
    expect((await h.current(id)).state.status).toBe("scheduled");
  });

  it("retains the cursor when a query uses the time budget, even with a stopped wall clock", async () => {
    const h = editorialHarness();
    const id = await h.create("review");
    h.clock.advance(3_600_000);
    let elapsed = 0;
    const records = new Map<JobName, JobRecord>();
    const store = createMemoryJobStore(records);
    const repository = {
      getState: h.app.persistence.repository.getState.bind(h.app.persistence.repository),
      queryActivity: h.app.persistence.repository.queryActivity.bind(h.app.persistence.repository),
      queryProjection: async (
        ...args: Parameters<typeof h.app.persistence.repository.queryProjection>
      ) => {
        elapsed += 20_000;
        return h.app.persistence.repository.queryProjection(...args);
      },
    };
    const jobs = createContentJobs({
      repository,
      dispatch: h.app.dispatch,
      objects: h.app.objects,
      store,
      clock: h.clock.now,
      monotonic: () => elapsed,
    });
    expect(await jobs.tick("dueReview")).toMatchObject({ status: "yielded", succeeded: 0 });
    expect(records.get("dueReview")!.progress.cursor).toBeNull();
    expect((await h.current(id)).state.review!.lastReminderDay).toBeNull();
    expect(
      (
        await createContentJobs({
          repository: h.app.persistence.repository,
          dispatch: h.app.dispatch,
          objects: h.app.objects,
          store,
          clock: h.clock.now,
        }).tick("dueReview")
      ).succeeded,
    ).toBe(1);
  });

  it("bounds a tick to 50 pages, including empty service pages with continuations", async () => {
    const h = editorialHarness();
    const query = vi.fn(async () => ({ items: [], nextCursor: "service-cursor" }));
    const repository = {
      getState: h.app.persistence.repository.getState.bind(h.app.persistence.repository),
      queryActivity: h.app.persistence.repository.queryActivity.bind(h.app.persistence.repository),
      queryProjection: query,
    };
    const jobs = createContentJobs({
      repository,
      dispatch: h.app.dispatch,
      objects: h.app.objects,
      store: createMemoryJobStore(),
      clock: h.clock.now,
    });
    expect(await jobs.tick("dueReview")).toMatchObject({ status: "yielded", examined: 50 });
    expect(query).toHaveBeenCalledTimes(50);
    for (const budget of [{ maxItems: 51 }, { maxItems: 0 }, { maxMs: 20_001 }])
      await expect(jobs.tick("dueReview", budget)).rejects.toThrow("Invalid job budget");
  });
});

describe("authoritative asset maintenance", () => {
  it("cannot use a saved future cutoff to delete a young object after clock rollback", async () => {
    const h = editorialHarness();
    const id = await h.create();
    const slot = await h.register(id);
    h.clock.advance(3_600_000);
    await h.app.jobs.tick("expireUploads");
    h.clock.advance(25 * 3_600_000);
    await h.app.objects.create(slot, png);
    const regressed = h.clock.now();
    h.clock.advance(25 * 3_600_000);
    const store = createMemoryJobStore();
    const lease = (await store.acquire("cleanupOrphans", h.clock.now()))!;
    await store.save(
      lease,
      { passCutoff: h.clock.now().toISOString(), cursor: null },
      h.clock.now(),
      true,
    );
    const jobs = createContentJobs({
      repository: h.app.persistence.repository,
      dispatch: h.app.dispatch,
      objects: h.app.objects,
      store,
      clock: () => regressed,
    });
    expect((await jobs.tick("cleanupOrphans")).succeeded).toBe(0);
    expect(
      await h.app.objects.inspectAssetObject({ contentId: id, assetId: slot.assetId }),
    ).toBeDefined();
  });
  it("expires abandoned uploads, deletes only old unverified retired objects, and retains tombstones/verified history", async () => {
    const h = editorialHarness();
    const id = await h.create();
    const abandoned = await h.register(id);
    const ref = await h.app.objects.create(abandoned, png);
    const verified = await h.register(id);
    await h.app.upload({
      contentId: id,
      assetId: verified.assetId,
      identity: (await import("../../src/shared/identities")).fixtureAuth("author_1"),
      body: png,
    });
    h.check(
      await h.run(id, "removeAsset", {
        expectedVersion: (await h.current(id)).version,
        assetId: verified.assetId,
      }),
    );
    h.clock.advance(3_600_000);
    expect((await h.app.jobs.tick("expireUploads")).succeeded).toBe(1);
    expect((await h.app.jobs.tick("cleanupOrphans")).succeeded).toBe(0);
    h.clock.advance(24 * 3_600_000);
    expect((await h.app.jobs.tick("cleanupOrphans")).succeeded).toBe(1);
    await expect(h.app.objects.read(ref)).rejects.toMatchObject({ code: "resource.not_found" });
    expect(
      await h.app.objects.inspectAssetObject({ contentId: id, assetId: verified.assetId }),
    ).toBeDefined();
    expect((await h.current(id)).state.attachments).toHaveLength(2);
    expect((await h.current(id)).state.attachments[0]!.status).toBe("expired");
    expect((await h.app.jobs.tick("cleanupOrphans")).succeeded).toBe(0);
  });

  it("does not delete a late-created young orphan at an old retired slot", async () => {
    const h = editorialHarness();
    const id = await h.create();
    const slot = await h.register(id);
    h.clock.advance(3_600_000);
    await h.app.jobs.tick("expireUploads");
    h.clock.advance(25 * 3_600_000);
    await h.app.objects.create(slot, png);
    expect((await h.app.jobs.tick("cleanupOrphans")).succeeded).toBe(0);
    h.clock.advance(24 * 3_600_000);
    expect((await h.app.jobs.tick("cleanupOrphans")).succeeded).toBe(1);
  });

  it("never deletes on missing/corrupt authority, even when a candidate read model claims retirement", async () => {
    const h = editorialHarness();
    const id = await h.create();
    const slot = await h.register(id);
    await h.app.objects.create(slot, png);
    h.clock.advance(26 * 3_600_000);
    const candidate = {
      projectionName: "contentItem.orphanAssets",
      itemId: id,
      sort: "2026-10-31T12:00:00.000Z",
      data: { assetId: slot.assetId },
    };
    const remove = vi.spyOn(h.app.objects, "deleteAssetObject");
    const root = await h.current(id);
    const repo = h.app.persistence.repository;
    const jobs = createContentJobs({
      repository: {
        getState: repo.getState.bind(repo),
        queryActivity: repo.queryActivity.bind(repo),
        queryProjection: async () => ({ items: [candidate] }),
      },
      dispatch: h.app.dispatch,
      objects: h.app.objects,
      store: createMemoryJobStore(),
      clock: h.clock.now,
    });
    expect((await jobs.tick("cleanupOrphans")).ignored).toBe(1);
    h.app.persistence.store.resources.delete(`contentItem\0${id}`);
    expect((await jobs.tick("cleanupOrphans")).ignored).toBe(1);
    h.app.persistence.store.resources.set(`contentItem\0${id}`, {
      ...root,
      state: { malformed: true },
    });
    expect((await jobs.tick("cleanupOrphans")).failures).toHaveLength(1);
    expect(remove).not.toHaveBeenCalled();
  });
});
