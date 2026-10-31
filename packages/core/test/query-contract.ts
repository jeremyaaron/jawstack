import { describe, expect, it } from "vitest";
import type {
  ActivityRecord,
  Page,
  ProjectionQuery,
  ProjectionRecord,
  QueryRepository,
} from "../src/index";

export const contractProjection = (
  itemId: string,
  sort = "a",
  projectionName = "contentItem.list",
): ProjectionRecord => ({
  projectionName,
  itemId,
  sort,
  data: { title: itemId },
});
export const contractActivity = (
  activityId: string,
  occurredAt = "2026-10-31T12:00:00.000Z",
): ActivityRecord => ({
  resourceType: "contentItem",
  resourceId: "content_1",
  activityId,
  occurredAt,
  activityType: "edited",
  title: activityId,
  correlationId: "correlation_1",
});

export type QueryContractHarness = Readonly<{
  repository: QueryRepository;
  putProjection(record: ProjectionRecord): void | Promise<void>;
  removeProjection(record: ProjectionRecord): void | Promise<void>;
  removeActivity(record: ActivityRecord): void | Promise<void>;
}>;

export async function collectQuery<T>(read: (cursor?: string) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await read(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (++pages > 100) throw new Error("Query did not terminate within the contract page budget");
  } while (cursor !== undefined);
  return items;
}

export function queryContract(
  name: string,
  factory: (
    projections: readonly ProjectionRecord[],
    activity: readonly ActivityRecord[],
  ) => QueryContractHarness | Promise<QueryContractHarness>,
) {
  const projections = [
    contractProjection("c", "b"),
    contractProjection("b"),
    contractProjection("a"),
    contractProjection("d", "c#d"),
  ];
  const activity = [
    contractActivity("b"),
    contractActivity("a"),
    contractActivity("c", "2026-11-01T00:00:00.000Z"),
  ];
  describe(name, () => {
    const read = (repository: QueryRepository, query: ProjectionQuery) =>
      collectQuery((cursor) =>
        repository.queryProjection({ ...query, ...(cursor === undefined ? {} : { cursor }) }),
      );
    it.each([false, true])(
      "orders timestamp ties and suffixed keys with bounded pages (descending=%s)",
      async (descending) => {
        const { repository } = await factory(projections, activity);
        expect(
          (
            await read(repository, { projectionName: "contentItem.list", limit: 1, descending })
          ).map((item) => item.itemId),
        ).toEqual(descending ? ["d", "c", "b", "a"] : ["a", "b", "c", "d"]);
      },
    );
    it.each([
      { sortFrom: "a#b", sortBefore: "c#d", expected: ["b", "c"] },
      { sortBefore: "b", expected: ["a", "b"] },
      { sortFrom: "b#c", expected: ["c", "d"] },
      { sortFrom: "b", sortBefore: "b", expected: [] },
      { sortBefore: "", expected: [] },
    ])("honors half-open and empty ranges: %j", async ({ expected, ...bounds }) => {
      const { repository } = await factory(projections, activity);
      for (const descending of [false, true]) {
        expect(
          (
            await read(repository, {
              projectionName: "contentItem.list",
              limit: 1,
              descending,
              ...bounds,
            })
          ).map((item) => item.itemId),
        ).toEqual(descending ? [...expected].reverse() : expected);
      }
    });
    it("orders activity ties and scopes resources", async () => {
      const { repository } = await factory(projections, [
        ...activity,
        { ...contractActivity("other"), resourceId: "content_2" },
      ]);
      expect(
        (
          await collectQuery((cursor) =>
            repository.queryActivity({
              resourceType: "contentItem",
              resourceId: "content_1",
              limit: 1,
              ...(cursor === undefined ? {} : { cursor }),
            }),
          )
        ).map((item) => item.activityId),
      ).toEqual(["a", "b", "c"]);
      expect(
        await repository.queryActivity({ resourceType: "reviewTask", resourceId: "content_1" }),
      ).toEqual({ items: [] });
    });
    it.each([false, true])(
      "continues after a deleted projection boundary (descending=%s)",
      async (descending) => {
        const harness = await factory(projections, activity);
        const first = await harness.repository.queryProjection({
          projectionName: "contentItem.list",
          limit: 1,
          descending,
        });
        await harness.removeProjection(first.items[0]!);
        const remaining = await read(harness.repository, {
          projectionName: "contentItem.list",
          limit: 2,
          descending,
          cursor: first.nextCursor!,
        });
        expect(remaining.map((item) => item.itemId)).toEqual(
          descending ? ["c", "b", "a"] : ["b", "c", "d"],
        );
      },
    );
    it("continues after a deleted activity boundary", async () => {
      const harness = await factory(projections, activity);
      const first = await harness.repository.queryActivity({
        resourceType: "contentItem",
        resourceId: "content_1",
        limit: 1,
      });
      await harness.removeActivity(first.items[0]!);
      expect(
        (
          await collectQuery((cursor) =>
            harness.repository.queryActivity({
              resourceType: "contentItem",
              resourceId: "content_1",
              limit: 1,
              cursor: cursor ?? first.nextCursor!,
            }),
          )
        ).map((item) => item.activityId),
      ).toEqual(["b", "c"]);
    });
    it("changes sort/partition membership by explicit deletion and replacement", async () => {
      const harness = await factory(projections, activity);
      const previous = contractProjection("a");
      await harness.removeProjection(previous);
      await harness.putProjection({ ...previous, sort: "z#a" });
      expect(
        (await read(harness.repository, { projectionName: "contentItem.list", limit: 2 })).map(
          (item) => item.itemId,
        ),
      ).toEqual(["b", "c", "d", "a"]);
      await harness.removeProjection({ ...previous, sort: "z#a" });
      await harness.putProjection({
        ...previous,
        projectionName: "contentItem.status.approved",
        sort: "z#a",
      });
      expect(
        (await read(harness.repository, { projectionName: "contentItem.list", limit: 2 })).map(
          (item) => item.itemId,
        ),
      ).toEqual(["b", "c", "d"]);
      expect(
        (
          await read(harness.repository, {
            projectionName: "contentItem.status.approved",
            limit: 2,
          })
        ).map((item) => item.itemId),
      ).toEqual(["a"]);
    });
    it("rejects cursor reuse with a different resource, direction, or range", async () => {
      const { repository } = await factory(projections, activity);
      const first = await repository.queryProjection({
        projectionName: "contentItem.list",
        limit: 1,
      });
      for (const change of [
        { projectionName: "reviewTask.list" },
        { descending: true },
        { sortFrom: "a" },
        { sortBefore: "z" },
      ])
        await expect(
          repository.queryProjection({
            projectionName: "contentItem.list",
            cursor: first.nextCursor!,
            ...change,
          }),
        ).rejects.toMatchObject({ code: "query.invalid" });
      await expect(
        repository.queryActivity({
          resourceType: "contentItem",
          resourceId: "content_1",
          cursor: first.nextCursor!,
        }),
      ).rejects.toMatchObject({ code: "query.invalid" });
      expect(
        (
          await read(repository, {
            projectionName: "contentItem.list",
            cursor: first.nextCursor!,
            limit: 200,
          })
        ).map((item) => item.itemId),
      ).toEqual(["b", "c", "d"]);
    });
    it("matches UTF-8 ordering and returns detached records", async () => {
      const { repository } = await factory(
        ["\u{10000}", "\uE000", "a", "Z"].map((id) => contractProjection(id)),
        [],
      );
      const items = await read(repository, { projectionName: "contentItem.list", limit: 1 });
      expect(items.map((item) => item.itemId)).toEqual(["Z", "a", "\uE000", "\u{10000}"]);
      items[0]!.data.title = "changed";
      expect(
        (await read(repository, { projectionName: "contentItem.list", limit: 1 }))[0]!.data.title,
      ).toBe("Z");
    });
  });
}
