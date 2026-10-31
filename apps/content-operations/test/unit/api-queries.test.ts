import { InMemoryRepository, InMemoryStore } from "@jawstack/core";
import { projectionKey } from "@jawstack/aws-runtime";
import { describe, expect, it, vi } from "vitest";
import { createContentQueries } from "../../src/application/queries";
import { fixtureAuth } from "../../src/shared/identities";

const instant = "2026-10-31T12:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function harness() {
  const store = new InMemoryStore();
  const repository = new InMemoryRepository(store);
  const seed = (count: number) => {
    for (let n = 1; n <= count; n++) {
      const row = {
        projectionName: "contentItem.list",
        itemId: uuid(n),
        sort: `${instant}#${uuid(n)}`,
        data: {
          title: n === 250 ? "Needle" : "Other",
          status: "draft",
          authorId: "author_1",
          revisionId: uuid(900),
          version: 1,
          createdAt: instant,
          updatedAt: instant,
          endpoint: "private",
        },
      };
      store.projections.set(
        JSON.stringify(projectionKey({ ...row, resourceType: "contentItem" })),
        row,
      );
    }
  };
  return {
    store,
    repository,
    seed,
    queries: createContentQueries({ repository, clock: () => new Date(instant) }),
  };
}
describe("application paging and filters", () => {
  it("returns empty filtered continuation after at most 200 candidates and reaches later matches", async () => {
    const h = harness();
    h.seed(260);
    const query = vi.spyOn(h.repository, "queryProjection");
    const first = await h.queries.content(fixtureAuth("author_1"), { title: "needle", limit: 50 });
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toBeDefined();
    expect(query.mock.calls.reduce((sum, [q]) => sum + q.limit!, 0)).toBe(200);
    const second = await h.queries.content(fixtureAuth("author_1"), {
      title: "NEEDLE",
      cursor: first.nextCursor,
      limit: 10,
    });
    expect(second.items.map((row) => row.itemId)).toEqual([uuid(250)]);
    expect(JSON.stringify(second)).not.toContain("private");
    expect(second.nextCursor).toBeUndefined();
  });
  it("binds cursors to normalized filters, fixture, query kind, ranges, and direction without allowing partitions", async () => {
    const h = harness();
    h.seed(10);
    const first = await h.queries.content(fixtureAuth("author_1"), { limit: 1 });
    for (const input of [
      { title: "other", cursor: first.nextCursor },
      { authorId: "author_2", cursor: first.nextCursor },
      { cursor: "not-a-cursor" },
      { limit: 101 },
      { projectionName: "FAILURE#anything" },
      { sortBefore: "arbitrary" },
    ])
      await expect(h.queries.content(fixtureAuth("author_1"), input)).rejects.toThrow();
    await expect(
      h.queries.content(fixtureAuth("author_2"), { cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "query.invalid" });
    await expect(
      h.queries.reviews(fixtureAuth("author_1"), { cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "query.invalid" });
    const key = [...h.store.projections.keys()][0]!;
    h.store.projections.delete(key);
    expect(
      (
        await h.queries.content(fixtureAuth("author_1"), { cursor: first.nextCursor, limit: 2 })
      ).items.map((row) => row.itemId),
    ).toEqual([uuid(2), uuid(3)]);
  });
  it("charges the requested evaluation budget for empty service pages", async () => {
    const h = harness();
    let count = 0;
    const query = vi
      .spyOn(h.repository, "queryProjection")
      .mockImplementation(async () => ({ items: [], nextCursor: `service-${++count}` }));
    const page = await h.queries.content(fixtureAuth("author_1"), {});
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeDefined();
    expect(query).toHaveBeenCalledTimes(4);
  });
  it("keeps overdue evaluation at the pass cutoff when clocks advance", async () => {
    const h = harness();
    let now = new Date(instant);
    for (let n = 1; n <= 3; n++) {
      const row = {
        projectionName: "reviewTask.pending",
        itemId: uuid(n),
        sort: `${instant}#${uuid(n)}`,
        data: {
          contentId: uuid(n + 10),
          title: "Review",
          status: "pending",
          assignedEditorId: "editor_1",
          dueAt: n === 3 ? "2026-10-31T13:00:00.000Z" : instant,
          sourceVersion: 2,
        },
      };
      h.store.projections.set(
        JSON.stringify(projectionKey({ ...row, resourceType: "reviewTask" })),
        row,
      );
    }
    const q = createContentQueries({ repository: h.repository, clock: () => now });
    const first = await q.reviews(fixtureAuth("editor_1"), { overdue: "true", limit: 1 });
    now = new Date("2026-11-01T12:00:00.000Z");
    const next = await q.reviews(fixtureAuth("editor_1"), {
      overdue: "true",
      cursor: first.nextCursor,
      limit: 10,
    });
    expect(next.items.map((row) => row.itemId)).toEqual([uuid(2)]);
  });
  it("bounds calendar ranges and restricts operations before reading any projection", async () => {
    const h = harness();
    const spy = vi.spyOn(h.repository, "queryProjection");
    for (const input of [
      { from: instant, before: instant },
      { from: instant, before: "2027-01-01T12:00:00.000Z" },
      { from: "2026-10-31T12:00:00.000", before: "2026-11-01T12:00:00.000Z" },
    ])
      await expect(h.queries.calendar(fixtureAuth("editor_1"), input)).rejects.toThrow();
    await expect(h.queries.operations(fixtureAuth("author_1"), {})).rejects.toMatchObject({
      code: "auth.forbidden",
    });
    await expect(
      h.queries.operations(fixtureAuth("editor_1"), { view: "attempts", recipientId: "author_1" }),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
