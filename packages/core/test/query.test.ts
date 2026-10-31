import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createInMemoryPersistence,
  JawStackRuntimeError,
  prepareActivityQuery,
  prepareProjectionQuery,
  type ActivityQuery,
  type ActivityRecord,
  type Page,
  type ProjectionQuery,
  type ProjectionRecord,
  type QueryRepository,
} from "../src/index";

const projectionName = "contentItem.list";
const instant = "2026-10-31T12:00:00.000Z";

function projection(itemId: string, sort = instant, name = projectionName): ProjectionRecord {
  return { projectionName: name, itemId, sort, data: { nested: { title: itemId } } };
}

function activity(
  activityId: string,
  occurredAt = instant,
  resourceId = "content_1",
): ActivityRecord {
  return {
    activityId,
    occurredAt,
    resourceType: "contentItem",
    resourceId,
    activityType: "edited",
    title: activityId,
    correlationId: "correlation_1",
    data: { nested: { title: activityId } },
  };
}

function fixture(
  projections: readonly ProjectionRecord[] = [],
  activities: readonly ActivityRecord[] = [],
) {
  const { repository, store } = createInMemoryPersistence();
  for (const record of projections)
    store.projections.set(`${record.projectionName}/${record.itemId}/${record.sort}`, record);
  store.activity.push(...activities);
  const queries: QueryRepository = repository;
  return { repository, store, queries };
}

async function allProjections(repository: QueryRepository, query: ProjectionQuery) {
  const items: ProjectionRecord[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page: Page<ProjectionRecord> = await repository.queryProjection({
      ...query,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
    if (++pages > 100) throw new Error("Projection paging did not terminate");
  } while (cursor !== undefined);
  return items;
}

function changeCursor(cursor: string, change: (value: Record<string, unknown>) => void) {
  const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  change(value);
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function expectInvalid(promise: Promise<unknown>) {
  await expect(promise).rejects.toBeInstanceOf(JawStackRuntimeError);
  await expect(promise).rejects.toMatchObject({ code: "query.invalid" });
}

describe("memory paged projection queries", () => {
  it("exports a standalone query contract and keeps existing empty array reads compatible", async () => {
    const { repository, queries } = fixture();
    expect(await queries.queryProjection({ projectionName })).toEqual({ items: [] });
    expect(
      await queries.queryActivity({ resourceType: "contentItem", resourceId: "content_1" }),
    ).toEqual({ items: [] });
    expect(await repository.listProjection(projectionName)).toEqual([]);
    expect(await repository.getActivity("contentItem", "content_1")).toEqual([]);
  });

  it.each([false, true])(
    "pages tied timestamps without gaps or duplicates (descending=%s)",
    async (descending) => {
      const { queries } = fixture([
        projection("c"),
        projection("a"),
        projection("b"),
        projection("d", "2026-10-31T13:00:00.000Z"),
        projection("foreign", instant, "reviewTask.list"),
      ]);
      const items = await allProjections(queries, { projectionName, descending, limit: 1 });
      expect(items.map((item) => item.itemId)).toEqual(
        descending ? ["d", "c", "b", "a"] : ["a", "b", "c", "d"],
      );
    },
  );

  it("uses UTF-8 byte order, not locale or UTF-16 order", async () => {
    const values = ["\u{10000}", "\uE000", "z", "a", "Z", "A"];
    const { queries } = fixture(values.map((value) => projection(value)));
    const items = await allProjections(queries, { projectionName, limit: 2 });
    expect(items.map((item) => item.itemId)).toEqual(["A", "Z", "a", "z", "\uE000", "\u{10000}"]);
  });

  it("matches the physical suffix rule rather than appending an item ID twice", async () => {
    const { queries } = fixture([
      projection("z", "a"),
      projection("a", "a#z#a"),
      projection("b", "a#z"),
    ]);
    const items = await allProjections(queries, { projectionName, limit: 1 });
    expect(items.map((item) => item.itemId)).toEqual(["z", "a", "b"]);
  });

  it.each([false, true])(
    "applies inclusive/exclusive physical key boundaries (descending=%s)",
    async (descending) => {
      const { queries } = fixture([
        projection("a", "a"),
        projection("b", "a"),
        projection("c", "b"),
        projection("d", "c"),
      ]);
      const items = await allProjections(queries, {
        projectionName,
        sortFrom: "a#b",
        sortBefore: "c#d",
        descending,
        limit: 1,
      });
      expect(items.map((item) => item.itemId)).toEqual(descending ? ["c", "b"] : ["b", "c"]);
      expect(
        (
          await queries.queryProjection({ projectionName, sortFrom: "a", sortBefore: "b" })
        ).items.map((item) => item.itemId),
      ).toEqual(["a", "b"]);
    },
  );

  it("supports each open-ended bound and returns empty for an equal or unmatched range", async () => {
    const { queries } = fixture([projection("a", "a"), projection("b", "b"), projection("c", "c")]);
    expect(
      (await queries.queryProjection({ projectionName, sortFrom: "b" })).items.map(
        (item) => item.itemId,
      ),
    ).toEqual(["b", "c"]);
    expect(
      (await queries.queryProjection({ projectionName, sortBefore: "b" })).items.map(
        (item) => item.itemId,
      ),
    ).toEqual(["a"]);
    expect(
      await queries.queryProjection({ projectionName, sortFrom: "b", sortBefore: "b" }),
    ).toEqual({ items: [] });
    expect(await queries.queryProjection({ projectionName, sortBefore: "" })).toEqual({
      items: [],
    });
    expect(await queries.queryProjection({ projectionName, sortFrom: "z" })).toEqual({ items: [] });
  });

  it("defaults to 50, caps at 200, and omits continuation at exact exhaustion", async () => {
    const { queries } = fixture(
      Array.from({ length: 201 }, (_, i) => projection(String(i).padStart(3, "0"))),
    );
    const page = await queries.queryProjection({ projectionName });
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBeTypeOf("string");
    const large = await queries.queryProjection({ projectionName, limit: 200 });
    expect(large.items).toHaveLength(200);
    expect(
      await queries.queryProjection({ projectionName, limit: 1, cursor: large.nextCursor! }),
    ).toEqual({ items: [projection("200")] });
    const exact = fixture([projection("a"), projection("b")]);
    expect(await exact.queries.queryProjection({ projectionName, limit: 2 })).toEqual({
      items: [projection("a"), projection("b")],
    });
  });

  it.each([false, true])(
    "continues after a deleted boundary item without relying on its existence (descending=%s)",
    async (descending) => {
      const { queries, store } = fixture([
        projection("a"),
        projection("b"),
        projection("c"),
        projection("d"),
      ]);
      const first = await queries.queryProjection({ projectionName, limit: 2, descending });
      const boundaryId = first.items.at(-1)!.itemId;
      for (const [key, value] of store.projections)
        if (value.itemId === boundaryId) store.projections.delete(key);
      const next = await queries.queryProjection({
        projectionName,
        limit: 2,
        descending,
        cursor: first.nextCursor!,
      });
      expect(next.items.map((item) => item.itemId)).toEqual(descending ? ["b", "a"] : ["c", "d"]);
      expect(next.nextCursor).toBeUndefined();
    },
  );

  it("allows cursor replay and a new page size, but does not promise a snapshot", async () => {
    const { queries, store } = fixture([projection("a"), projection("c"), projection("d")]);
    const first = await queries.queryProjection({ projectionName, limit: 1 });
    const nextQuery = { projectionName, limit: 2, cursor: first.nextCursor! };
    expect(await queries.queryProjection(nextQuery)).toEqual(
      await queries.queryProjection(nextQuery),
    );
    store.projections.set("new-before", projection("0"));
    store.projections.set("new-after", projection("b"));
    expect((await queries.queryProjection(nextQuery)).items.map((item) => item.itemId)).toEqual([
      "b",
      "c",
    ]);
  });

  it("can return an empty terminal page when every remaining record was deleted", async () => {
    const { queries, store } = fixture([projection("a"), projection("b")]);
    const first = await queries.queryProjection({ projectionName, limit: 1 });
    store.projections.clear();
    expect(await queries.queryProjection({ projectionName, cursor: first.nextCursor! })).toEqual({
      items: [],
    });
  });

  it("returns detached copies without changing legacy array ordering", async () => {
    const { queries, repository, store } = fixture([projection("b"), projection("a")]);
    const page = await queries.queryProjection({ projectionName, limit: 1 });
    (page.items[0]!.data.nested as { title: string }).title = "changed";
    expect((await queries.queryProjection({ projectionName })).items[0]!.data).toEqual({
      nested: { title: "a" },
    });
    expect((await repository.listProjection(projectionName)).map((item) => item.itemId)).toEqual([
      "b",
      "a",
    ]);
    expect([...store.projections.values()].map((item) => item.itemId)).toEqual(["b", "a"]);
  });

  it.each([0, -1, 201, 1.5, NaN, Infinity, "2", null])(
    "rejects invalid limits (%s)",
    async (limit) => {
      const { queries } = fixture();
      await expectInvalid(queries.queryProjection({ projectionName, limit } as ProjectionQuery));
      await expectInvalid(
        queries.queryActivity({
          resourceType: "contentItem",
          resourceId: "content_1",
          limit,
        } as ActivityQuery),
      );
    },
  );

  it.each([
    { projectionName: "list" },
    { projectionName: "contentItem." },
    { projectionName: "contentItem..list" },
    { projectionName: "contentItem.list\n" },
    { projectionName: "contentItem.list\u2028" },
    { projectionName: "contentItem.list#other" },
    { projectionName: `contentItem.${"x".repeat(2048)}` },
    { sortFrom: "z", sortBefore: "a" },
    { sortFrom: "x".repeat(1025) },
    { sortBefore: "\uE000".repeat(342) },
    { sortFrom: "\uD800" },
    { descending: "true" },
    { filter: "unscoped" },
    { partition: "arbitrary" },
    { exclusiveStartKey: {} },
  ])("rejects invalid projection query shape or range: %j", async (changes) => {
    const { queries } = fixture();
    await expectInvalid(queries.queryProjection({ projectionName, ...changes } as ProjectionQuery));
  });
});

describe("memory activity paging", () => {
  it("round-trips continuation keys with valid UTF-8 control and non-BMP ID characters", async () => {
    const { queries } = fixture([], [activity("a\n\u0000\u{10000}"), activity("b")]);
    const first = await queries.queryActivity({
      resourceType: "contentItem",
      resourceId: "content_1",
      limit: 1,
    });
    expect(first.items[0]!.activityId).toBe("a\n\u0000\u{10000}");
    expect(
      await queries.queryActivity({
        resourceType: "contentItem",
        resourceId: "content_1",
        cursor: first.nextCursor!,
      }),
    ).toEqual({ items: [activity("b")] });
  });

  it("orders tied timestamps by activity ID and isolates resource type and ID", async () => {
    const { queries, repository } = fixture(
      [],
      [
        activity("z"),
        activity("a"),
        activity("b"),
        activity("last", "2026-11-01T00:00:00.000Z"),
        activity("other", instant, "content_2"),
        { ...activity("wrongType"), resourceType: "reviewTask" },
      ],
    );
    const items: ActivityRecord[] = [];
    let cursor: string | undefined;
    do {
      const page: Page<ActivityRecord> = await queries.queryActivity({
        resourceType: "contentItem",
        resourceId: "content_1",
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      items.push(...page.items);
      cursor = page.nextCursor;
      if (items.length > 5) throw new Error("Activity paging did not terminate");
    } while (cursor !== undefined);
    expect(items.map((item) => item.activityId)).toEqual(["a", "b", "z", "last"]);
    expect(
      (await repository.getActivity("contentItem", "content_1")).map((item) => item.activityId),
    ).toEqual(["z", "a", "b", "last"]);
  });

  it("continues beyond deleted activity records and clones nested data", async () => {
    const { queries, store } = fixture([], [activity("b"), activity("a"), activity("c")]);
    const first = await queries.queryActivity({
      resourceType: "contentItem",
      resourceId: "content_1",
      limit: 1,
    });
    (first.items[0]!.data!.nested as { title: string }).title = "changed";
    expect(store.activity.find((item) => item.activityId === "a")!.title).toBe("a");
    expect(store.activity.find((item) => item.activityId === "a")!.data).toEqual({
      nested: { title: "a" },
    });
    store.activity.splice(
      store.activity.findIndex((item) => item.activityId === "a"),
      1,
    );
    expect(
      (
        await queries.queryActivity({
          resourceType: "contentItem",
          resourceId: "content_1",
          cursor: first.nextCursor!,
        })
      ).items.map((item) => item.activityId),
    ).toEqual(["b", "c"]);
    store.activity.splice(0);
    expect(
      await queries.queryActivity({
        resourceType: "contentItem",
        resourceId: "content_1",
        cursor: first.nextCursor!,
      }),
    ).toEqual({ items: [] });
  });

  it("uses the same default and maximum page size as projection queries", async () => {
    const { queries } = fixture(
      [],
      Array.from({ length: 201 }, (_, i) => activity(String(i).padStart(3, "0"))),
    );
    expect(
      (await queries.queryActivity({ resourceType: "contentItem", resourceId: "content_1" })).items,
    ).toHaveLength(50);
    const first = await queries.queryActivity({
      resourceType: "contentItem",
      resourceId: "content_1",
      limit: 200,
    });
    expect(first.items).toHaveLength(200);
    expect(
      await queries.queryActivity({
        resourceType: "contentItem",
        resourceId: "content_1",
        limit: 1,
        cursor: first.nextCursor!,
      }),
    ).toEqual({ items: [activity("200")] });
  });

  it.each([
    { resourceType: "" },
    { resourceType: "contentItem#other" },
    { resourceType: "contentItem\n" },
    { resourceId: "" },
    { resourceId: "x".repeat(2048) },
    { resourceId: "\uDC00" },
    { descending: true },
    { sortFrom: instant },
  ])("rejects invalid activity query shape: %j", async (changes) => {
    const { queries } = fixture();
    await expectInvalid(
      queries.queryActivity({
        resourceType: "contentItem",
        resourceId: "content_1",
        ...changes,
      } as ActivityQuery),
    );
  });
});

describe("query cursor validation", () => {
  it("retains version-1 SHA-256 cursor fingerprints with native Web Crypto", async () => {
    const { queries } = fixture([projection("a"), projection("b")], [activity("a"), activity("b")]);
    const legacyCursor = (parts: readonly unknown[], key: string) =>
      Buffer.from(
        JSON.stringify({
          version: 1,
          scope: createHash("sha256").update(JSON.stringify(parts)).digest("hex"),
          key: Buffer.from(key).toString("base64url"),
        }),
      ).toString("base64url");
    expect(
      (
        await queries.queryProjection({
          projectionName,
          cursor: legacyCursor(
            ["projection", "PROJ#contentItem#list", null, null, false],
            `${instant}#a`,
          ),
        })
      ).items.map((item) => item.itemId),
    ).toEqual(["b"]);
    expect(
      (
        await queries.queryActivity({
          resourceType: "contentItem",
          resourceId: "content_1",
          cursor: legacyCursor(["activity", "RES#contentItem#content_1"], `ACT#${instant}#a`),
        })
      ).items.map((item) => item.activityId),
    ).toEqual(["b"]);
  });

  it("shares normalized queries and scope-checked cursor writers with adapters", async () => {
    const projection = await prepareProjectionQuery({
      projectionName,
      sortFrom: "a",
      sortBefore: "z",
    });
    expect(projection.query).toEqual({
      projectionName,
      sortFrom: "a",
      sortBefore: "z",
      descending: false,
      limit: 50,
    });
    expect(() => projection.cursorAfter("z")).toThrow(JawStackRuntimeError);
    expect(() => projection.cursorAfter("0")).toThrow(JawStackRuntimeError);
    const activity = await prepareActivityQuery({
      resourceType: "contentItem",
      resourceId: "content_1",
    });
    expect(activity.query.limit).toBe(50);
    expect(() => activity.cursorAfter("STATE")).toThrow(JawStackRuntimeError);
    const replay = await prepareActivityQuery({
      resourceType: "contentItem",
      resourceId: "content_1",
      cursor: activity.cursorAfter(`ACT#${instant}#a`),
    });
    expect(replay.after).toBe(`ACT#${instant}#a`);
  });

  async function cursorFixture() {
    const result = fixture(
      [projection("a", "a"), projection("b", "b")],
      [activity("a"), activity("b")],
    );
    const page = await result.queries.queryProjection({ projectionName, limit: 1 });
    return { ...result, cursor: page.nextCursor! };
  }

  it.each(["", "not-json", "=", "e30=", "x".repeat(4097), "//", 1, null])(
    "rejects malformed or oversized cursors (%s)",
    async (cursor) => {
      const { queries } = fixture();
      await expectInvalid(queries.queryProjection({ projectionName, cursor } as ProjectionQuery));
      await expectInvalid(
        queries.queryActivity({
          resourceType: "contentItem",
          resourceId: "content_1",
          cursor,
        } as ActivityQuery),
      );
    },
  );

  it.each([
    (v: Record<string, unknown>) => {
      v.version = 2;
    },
    (v: Record<string, unknown>) => {
      delete v.scope;
    },
    (v: Record<string, unknown>) => {
      v.scope = "0".repeat(64);
    },
    (v: Record<string, unknown>) => {
      v.key = {};
    },
    (v: Record<string, unknown>) => {
      v.key = "";
    },
    (v: Record<string, unknown>) => {
      v.key = Buffer.from("x".repeat(1025)).toString("base64url");
    },
    (v: Record<string, unknown>) => {
      v.key = Buffer.from([255]).toString("base64url");
    },
    (v: Record<string, unknown>) => {
      v.key = "YQ==";
    },
    (v: Record<string, unknown>) => {
      v.partition = "foreign";
    },
  ])("rejects invalid cursor envelope/key %#", async (change) => {
    const { queries, cursor } = await cursorFixture();
    await expectInvalid(
      queries.queryProjection({ projectionName, cursor: changeCursor(cursor, change) }),
    );
  });

  it("rejects noncanonical base64url and invalid UTF-8 before parsing", async () => {
    const { queries } = fixture();
    for (const cursor of [
      "Zh",
      Buffer.from([255]).toString("base64url"),
      Buffer.from("{}").toString("base64url"),
    ])
      await expectInvalid(queries.queryProjection({ projectionName, cursor }));
  });

  it("rejects reuse across projection names, ranges, directions, and query kinds", async () => {
    const { queries, cursor } = await cursorFixture();
    for (const changes of [
      { projectionName: "reviewTask.list" },
      { projectionName: "contentItem.status.open" },
      { sortFrom: "a" },
      { sortBefore: "z" },
      { descending: true },
    ])
      await expectInvalid(queries.queryProjection({ projectionName, cursor, ...changes }));
    await expectInvalid(
      queries.queryActivity({ resourceType: "contentItem", resourceId: "content_1", cursor }),
    );
    const page = await queries.queryActivity({
      resourceType: "contentItem",
      resourceId: "content_1",
      limit: 1,
    });
    await expectInvalid(
      queries.queryActivity({
        resourceType: "contentItem",
        resourceId: "content_2",
        cursor: page.nextCursor!,
      }),
    );
    await expectInvalid(
      queries.queryActivity({
        resourceType: "reviewTask",
        resourceId: "content_1",
        cursor: page.nextCursor!,
      }),
    );
    await expectInvalid(queries.queryProjection({ projectionName, cursor: page.nextCursor! }));
    const badActivityKey = changeCursor(page.nextCursor!, (v) => {
      v.key = Buffer.from("STATE").toString("base64url");
    });
    await expectInvalid(
      queries.queryActivity({
        resourceType: "contentItem",
        resourceId: "content_1",
        cursor: badActivityKey,
      }),
    );
  });

  it("checks the continuation key itself against both range boundaries", async () => {
    const { queries } = await cursorFixture();
    const range = { projectionName, sortFrom: "a", sortBefore: "z", limit: 1 };
    const first = await queries.queryProjection(range);
    for (const key of ["0", "z"])
      await expectInvalid(
        queries.queryProjection({
          ...range,
          cursor: changeCursor(first.nextCursor!, (v) => {
            v.key = Buffer.from(key).toString("base64url");
          }),
        }),
      );
  });

  it("normalizes default direction but intentionally excludes page size from scope", async () => {
    const { queries, cursor } = await cursorFixture();
    expect(
      await queries.queryProjection({ projectionName, descending: false, cursor, limit: 200 }),
    ).toEqual({ items: [projection("b", "b")] });
  });

  it("keeps encoded cursors bounded even with escaped control characters in a valid key", async () => {
    const { queries } = fixture([projection("a", "\u0000".repeat(1000)), projection("b", "z")]);
    const first = await queries.queryProjection({ projectionName, limit: 1 });
    expect(first.nextCursor!.length).toBeLessThanOrEqual(4096);
    expect(await queries.queryProjection({ projectionName, cursor: first.nextCursor! })).toEqual({
      items: [projection("b", "z")],
    });
  });
});
