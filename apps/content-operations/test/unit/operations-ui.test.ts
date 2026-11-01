import "@angular/compiler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { operationsHarness } from "../support/operations";
import { PublicationExecutionError } from "../../src/application/publication-artifact";
import { SimulatedPublicationCrash } from "../../src/application/publisher";
import { publicationRecovery } from "../../src/shared/publication-recovery";
import { RecoverySession } from "../../src/web/recovery-session";
import { createFailureService } from "../../src/application/failures";
import { publicationRequestSchema } from "../../src/shared/contracts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function setup() {
  const h = await operationsHarness();
  cleanups.push(h.close);
  vi.spyOn(Date, "now").mockImplementation(() => h.clock.now().getTime());
  return h;
}
describe("publication recovery and operation DTOs", () => {
  it("pauses hidden recovery polling, backs off after a minute, and aborts/removes work on destruction", async () => {
    const h = await setup();
    const id = await h.create();
    const row = await h.current(id);
    const read = vi.spyOn(h.client, "getContent").mockResolvedValue(row);
    let hidden = false;
    const document = new EventTarget() as Document;
    Object.defineProperty(document, "hidden", { get: () => hidden });
    vi.useFakeTimers();
    vi.setSystemTime(h.clock.now());
    const session = new RecoverySession(
      h.client,
      () => "editor_1",
      () => row,
      () => {},
      document,
      () => false,
    );
    session.update();
    await vi.advanceTimersByTimeAsync(2000);
    expect(read).toHaveBeenCalledTimes(1);
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(read.mock.calls[0]![1]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(61000);
    expect(read).toHaveBeenCalledTimes(1);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(9999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    session.destroy();
    await vi.advanceTimersByTimeAsync(20000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
  it("enforces the final generation budget in both UI policy and the public command", async () => {
    const h = await setup();
    const id = await h.create();
    for (let generation = 1; generation <= 4; generation++) {
      await h.runtime.app.failures.collect("publishContent", h.wire(id));
      const row = await h.current(id);
      const input = {
        expectedVersion: row.version,
        publicationId: row.state.publication!.intent.publicationId,
        generation,
      };
      if (generation < 4) await h.client.mutate("retryPublication", input, id);
      else {
        expect(publicationRecovery(row.state.publication!, Date.now()).eligible).toBe(false);
        await expect(h.client.mutate("retryPublication", input, id)).rejects.toBeDefined();
      }
    }
  });
  it("distinguishes queued, live, expired, terminal and exhausted states using the domain's eligibility policy", async () => {
    const h = await setup();
    const id = await h.create();
    let row = await h.current(id);
    expect(publicationRecovery(row.state.publication!, Date.now())).toMatchObject({
      status: "queued",
      eligible: false,
      remainingGenerations: 3,
    });
    await expect(
      h.publish(id, (point) => {
        if (point === "afterClaim") throw new SimulatedPublicationCrash();
      }),
    ).rejects.toThrow();
    row = await h.current(id);
    expect(publicationRecovery(row.state.publication!, Date.now())).toMatchObject({
      status: "running",
      liveLease: true,
      eligible: false,
    });
    await expect(
      h.client.mutate(
        "retryPublication",
        {
          expectedVersion: row.version,
          publicationId: row.state.publication!.intent.publicationId,
          generation: 1,
        },
        id,
      ),
    ).rejects.toMatchObject({ status: 409 });
    h.clock.advance(90000);
    expect(publicationRecovery(row.state.publication!, Date.now())).toMatchObject({
      status: "stalled",
      expiredLease: true,
      eligible: true,
    });
    expect(
      publicationRecovery({ ...row.state.publication!, generation: 4 }, Date.now()),
    ).toMatchObject({ eligible: false, remainingGenerations: 0 });
  });
  it("retries a terminal failed publication with a stable key after a lost response, retaining exactly one stored artifact", async () => {
    const h = await setup();
    const id = await h.create();
    await expect(
      h.publish(id, (point) => {
        if (point === "beforeCompletion") throw new PublicationExecutionError("artifact.mismatch");
      }),
    ).rejects.toThrow();
    let row = await h.current(id);
    const original = publicationRequestSchema.parse(h.wire(id).payload).intent;
    const bytes = await h.runtime.objects.readPublication(original);
    const document = new EventTarget() as Document;
    Object.defineProperty(document, "hidden", { value: false });
    const session = new RecoverySession(
      h.client,
      () => "editor_1",
      () => row,
      (next) => {
        row = next;
      },
      document,
      () => false,
    );
    cleanups.push(() => session.destroy());
    session.update();
    const mutate = h.client.mutate.bind(h.client);
    let lost = true;
    const spy = vi
      .spyOn(h.client, "mutate")
      .mockImplementation(async (name, input, target, key) => {
        const result = await mutate(name, input, target, key);
        if (lost) {
          lost = false;
          throw new TypeError("lost response");
        }
        return result;
      });
    await session.retry();
    expect(session.action.error()).toContain("preserved");
    expect(row.state.publication!.generation).toBe(1);
    await session.retry();
    expect(spy.mock.calls[0]![3]).toBe(spy.mock.calls[1]![3]);
    expect(row.state.publication!.generation).toBe(2);
    session.update();
    await h.publish(id);
    await h.runtime.app.drainUntilIdle();
    row = await h.current(id);
    session.update();
    expect(row.state.status).toBe("published");
    expect(row.state.publication!.intent).toEqual(original);
    expect(await h.runtime.objects.readPublication(original)).toEqual(bytes);
    expect((await h.client.publication(id)).artifact.publicationId).toBe(original.publicationId);
    const attempts = await h.client.operations({ view: "attempts", contentId: id, limit: 1 });
    expect(attempts.items).toHaveLength(1);
    expect(attempts.nextCursor).toBeDefined();
    const next = await h.client.operations({
      view: "attempts",
      contentId: id,
      cursor: attempts.nextCursor!,
      limit: 1,
    });
    expect(next.items).toHaveLength(1);
    expect(next.items[0]!.itemId).not.toBe(attempts.items[0]!.itemId);
    const notifications = await h.client.operations({
      view: "notifications",
      contentId: id,
      recipientId: "author_1",
    });
    expect(notifications.items.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify([attempts, notifications])).not.toMatch(/objectKey|fencingToken/);
    h.actor("author_1");
    await expect(h.client.operations()).rejects.toMatchObject({ status: 403 });
    await expect(
      h.client.mutate(
        "retryPublication",
        { expectedVersion: row.version, publicationId: original.publicationId, generation: 2 },
        id,
      ),
    ).rejects.toMatchObject({ status: 403 });
    h.actor("editor_1");
    await expect(
      h.client.mutate(
        "retryPublication",
        { expectedVersion: row.version, publicationId: original.publicationId, generation: 2 },
        id,
      ),
    ).rejects.toBeDefined();
  });
  it("retains a stale retry base and never adopts a newer generation after a conflict", async () => {
    const h = await setup();
    const id = await h.create();
    await h.runtime.app.failures.collect("publishContent", h.wire(id));
    const row = await h.current(id);
    const document = new EventTarget() as Document;
    Object.defineProperty(document, "hidden", { value: false });
    const session = new RecoverySession(
      h.client,
      () => "editor_1",
      () => row,
      () => {
        throw new Error("Must not adopt conflict");
      },
      document,
      () => false,
    );
    cleanups.push(() => session.destroy());
    session.update();
    await h.client.mutate(
      "retryPublication",
      {
        expectedVersion: row.version,
        publicationId: row.state.publication!.intent.publicationId,
        generation: 1,
      },
      id,
    );
    await session.retry();
    expect(session.action.conflict()).toBe(true);
    expect(row.state.publication!.generation).toBe(1);
    expect(session.action.error()).toContain("preserved");
  });
  it("serves resumable collection history without exposing stored source payloads or a browser replay endpoint", async () => {
    const h = await setup();
    const id = await h.create();
    const source = h.wire(id);
    const collector = createFailureService({
      store: h.runtime.app.failureStore,
      repository: h.runtime.repository,
      dispatch: h.runtime.dispatch,
      clock: h.clock.now,
      source: "content-operations",
      fault: (point) => {
        if (point === "afterRecord") throw new Error("Collector interrupted");
      },
    });
    await expect(collector.collect("publishContent", source)).rejects.toThrow();
    const pending = await h.client.operations({ view: "failures", contentId: id });
    expect(pending.items[0]!.data).toMatchObject({ status: "reconciling", resolution: "pending" });
    await h.runtime.app.failures.collect("publishContent", source);
    const failed = await h.client.operations({ view: "failures", contentId: id });
    expect(failed.items[0]!.data).toMatchObject({ status: "failed", resolution: "stalled" });
    expect(JSON.stringify(failed)).not.toMatch(/"original":|objectKey|fencingToken/);
    expect(
      (
        await fetch(`${h.api.baseUrl}/api/jobs/replay`, {
          method: "POST",
          headers: { "x-content-ops-fixture": "editor_1", "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(404);
  });
});
