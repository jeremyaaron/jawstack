import "@angular/compiler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryApiRuntime } from "../../src/application/api-runtime";
import { startContentApi } from "../../src/http/server";
import { ContentOperationsClient } from "../../src/web/client";
import { ReviewSession } from "../../src/web/review-session";
import { VisibilityPoll } from "../../src/web/visibility-poll";
import type { FixtureId } from "../../src/shared/identities";

const apis: Awaited<ReturnType<typeof startContentApi>>[] = [];
afterEach(async () => {
  await Promise.all(apis.splice(0).map((api) => api.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function setup() {
  const runtime = createMemoryApiRuntime();
  const api = await startContentApi({ runtime, port: 0, managed: false });
  apis.push(api);
  let actor: FixtureId = "author_1";
  const client = new ContentOperationsClient({ fixture: () => actor, base: `${api.baseUrl}/api` });
  const created = await client.mutate("create", {
    title: "Submitted title",
    body: "Immutable original body",
  });
  await client.mutate(
    "submit",
    {
      expectedVersion: 1,
      assignedEditorId: "editor_2",
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    created.resourceId,
  );
  const row = await client.getContent(created.resourceId);
  const id = row.state.review!.reviewId;
  const session = new ReviewSession(client, () => actor);
  return {
    runtime,
    client,
    session,
    id,
    contentId: created.resourceId,
    actor: (next: FixtureId) => {
      actor = next;
    },
  };
}
describe("HTTP-backed review session", () => {
  it("uses authority during materialization delay and completes changes/resubmission/approval with immutable history", async () => {
    const h = await setup();
    await h.session.load(h.id, h.contentId);
    expect(h.session.syncing()).toBe(true);
    expect(h.session.materialized()).toBe(false);
    expect(h.session.canDecide()).toBe(false);
    h.actor("editor_1");
    expect(h.session.canDecide()).toBe(true);
    expect(await h.session.decide("approve")).toBe(false);
    expect(h.session.validation()).toContain("decision note");
    h.session.note.setValue("Clarify the summary");
    expect(await h.session.decide("requestChanges")).toBe(true);
    expect((await h.client.getContent(h.contentId)).state.status).toBe("draft");
    h.actor("author_1");
    await h.client.mutate(
      "editDraft",
      { expectedVersion: 3, title: "Revised title", body: "Revised body" },
      h.contentId,
    );
    await h.client.mutate(
      "submit",
      {
        expectedVersion: 4,
        assignedEditorId: "editor_2",
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      h.contentId,
    );
    const nextId = (await h.client.getContent(h.contentId)).state.review!.reviewId;
    expect(nextId).not.toBe(h.id);
    h.actor("editor_2");
    await h.session.load(nextId, h.contentId);
    h.session.note.setValue("Approved revision");
    expect(await h.session.decide("approve")).toBe(true);
    await h.runtime.app.drainUntilIdle();
    const old = await h.client.getReview(h.id);
    expect(old.state.submitted.body).toBe("Immutable original body");
    expect(old.state.decision?.note).toBe("Clarify the summary");
    const page = await h.client.reviews({ contentId: h.contentId, limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    const next = await h.client.reviews({
      contentId: h.contentId,
      cursor: page.nextCursor!,
      limit: 1,
    });
    expect(next.items).toHaveLength(1);
    expect(next.items[0]!.itemId).not.toBe(page.items[0]!.itemId);
    await expect(
      h.client.reviews({ contentId: crypto.randomUUID(), cursor: page.nextCursor! }),
    ).rejects.toMatchObject({ code: "query.invalid" });
    const activity = await h.client.activityPage("contentItem", h.contentId, { limit: 2 });
    expect(activity.nextCursor).toBeDefined();
    expect(activity.items).toHaveLength(2);
    const more = await h.client.activityPage("contentItem", h.contentId, {
      limit: 2,
      cursor: activity.nextCursor!,
    });
    expect(more.items[0]!.activityId).not.toBe(activity.items[0]!.activityId);
    expect(JSON.stringify(old)).not.toMatch(/objectKey|fencingToken/);
    h.session.destroy();
  });
  it("cannot approve a reopened/new revision and never refreshes its decision base during model sync", async () => {
    const h = await setup();
    h.actor("editor_1");
    await h.session.load(h.id, h.contentId);
    await h.client.mutate("reopenDraft", { expectedVersion: 2 }, h.contentId);
    await h.client.mutate(
      "editDraft",
      { expectedVersion: 3, title: "New revision", body: "New body" },
      h.contentId,
    );
    await h.client.mutate(
      "submit",
      {
        expectedVersion: 4,
        assignedEditorId: "editor_2",
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      h.contentId,
    );
    h.session.note.setValue("Note retained on conflict");
    expect(await h.session.decide("approve")).toBe(false);
    expect(h.session.action.conflict()).toBe(true);
    expect(h.session.note.value).toBe("Note retained on conflict");
    expect(h.session.authority()!.version).toBe(2);
    await h.runtime.app.drainUntilIdle();
    await h.session.sync(new AbortController().signal);
    expect(h.session.authority()!.version).toBe(2);
    expect(h.session.review()!.status).toBe("superseded");
    expect(h.session.canDecide()).toBe(false);
    await h.session.load(h.id, h.contentId);
    expect(h.session.current()).toBe(false);
    expect(h.session.note.value).toBe("Note retained on conflict");
    expect(h.session.canDecide()).toBe(false);
    expect((await h.client.getContent(h.contentId)).state.status).toBe("inReview");
    h.session.destroy();
  });
  it("retries a lost decision response with the same key, without recording another version", async () => {
    const h = await setup();
    h.actor("editor_1");
    await h.session.load(h.id, h.contentId);
    h.session.note.setValue("Stable decision");
    const original = h.client.mutate.bind(h.client);
    let lost = true;
    const mutate = vi.spyOn(h.client, "mutate").mockImplementation(async (name, input, id, key) => {
      const result = await original(name, input, id, key);
      if (lost) {
        lost = false;
        throw new TypeError("Response lost");
      }
      return result;
    });
    expect(await h.session.decide("approve")).toBe(false);
    expect(h.session.note.value).toBe("Stable decision");
    expect(await h.session.decide("approve")).toBe(true);
    expect(mutate.mock.calls[0]![3]).toBe(mutate.mock.calls[1]![3]);
    expect((await h.client.getContent(h.contentId)).version).toBe(3);
    h.session.destroy();
  });
});
describe("visible pending-review polling", () => {
  it("pauses hidden work, backs off after a minute, and removes timers on destruction", async () => {
    vi.useFakeTimers();
    let hidden = false;
    const document = new EventTarget() as Document;
    Object.defineProperty(document, "hidden", { get: () => hidden });
    const task = vi.fn(async () => true);
    const poll = new VisibilityPoll(document);
    poll.start(task);
    await vi.advanceTimersByTimeAsync(2000);
    expect(task).toHaveBeenCalledTimes(1);
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(task).toHaveBeenCalledTimes(1);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(9999);
    expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(task).toHaveBeenCalledTimes(2);
    poll.destroy();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(task).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("aborts in-flight polling when hidden and never overlaps a pending attempt", async () => {
    vi.useFakeTimers();
    let hidden = false;
    const document = new EventTarget() as Document;
    Object.defineProperty(document, "hidden", { get: () => hidden });
    let finish!: (keep: boolean) => void;
    let signal!: AbortSignal;
    const task = vi.fn((current: AbortSignal) => {
      signal = current;
      return new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    });
    const poll = new VisibilityPoll(document);
    poll.start(task);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(task).toHaveBeenCalledTimes(1);
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(signal.aborted).toBe(true);
    finish(true);
    await Promise.resolve();
    poll.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
