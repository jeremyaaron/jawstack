import { QueryCommand, type QueryCommandInput } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createInMemoryPersistence, prepareProjectionQuery } from "@jawstack/core";
import { describe, expect, it, vi } from "vitest";
import {
  collectQuery,
  contractActivity,
  contractProjection,
  queryContract,
} from "../../core/test/query-contract";
import {
  activityKey,
  DynamoDbRepository,
  projectionKey,
  toActivityItem,
  toProjectionItem,
  type DynamoDbItem,
} from "../src/index";

const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const projectionInput = (record: ReturnType<typeof contractProjection>) => ({
  ...record,
  resourceType: record.projectionName.split(".")[0]!,
  resourceId: record.itemId,
  updatedAt: "2026-10-31T12:00:00.000Z",
});
function sdkFixture(pageSize = 2) {
  const rows = new Map<string, DynamoDbItem>();
  const put = (item: DynamoDbItem) => {
    rows.set(`${item.PK!.S}\u0000${item.SK!.S}`, item);
  };
  const remove = (key: { PK: string; SK: string }) => {
    rows.delete(`${key.PK}\u0000${key.SK}`);
  };
  const send = vi.fn(async (command: { input: unknown }) => {
    expect(command).toBeInstanceOf(QueryCommand);
    const input = command.input as QueryCommandInput;
    expect(input.TableName).toBe("query-test");
    expect(input.Limit).toBeGreaterThan(0);
    expect(input.Limit).toBeLessThanOrEqual(200);
    const values = unmarshall(input.ExpressionAttributeValues!);
    const direction = input.ScanIndexForward === false ? -1 : 1;
    const start = input.ExclusiveStartKey?.SK?.S;
    const eligible = [...rows.values()]
      .filter((row) => {
        const key = row.SK!.S!;
        if (
          row.PK?.S !== values[":pk"] ||
          (start !== undefined && compare(key, start) * direction <= 0)
        )
          return false;
        if (
          input.KeyConditionExpression === "PK = :pk AND SK >= :bound" &&
          compare(key, values[":bound"]) < 0
        )
          return false;
        if (
          input.KeyConditionExpression === "PK = :pk AND SK < :bound" &&
          compare(key, values[":bound"]) >= 0
        )
          return false;
        if (
          input.KeyConditionExpression === "PK = :pk AND begins_with(SK, :prefix)" &&
          !key.startsWith(values[":prefix"])
        )
          return false;
        return true;
      })
      .sort((a, b) => compare(a.SK!.S!, b.SK!.S!) * direction);
    const evaluated = eligible.slice(0, Math.min(pageSize, input.Limit!));
    const last = evaluated.at(-1);
    return {
      Items: structuredClone(evaluated.filter((row) => row.itemKind?.S === values[":kind"])),
      ...(last && evaluated.length === Math.min(pageSize, input.Limit!)
        ? { LastEvaluatedKey: { PK: last.PK, SK: last.SK } }
        : {}),
    };
  });
  return {
    rows,
    put,
    remove,
    send,
    repository: new DynamoDbRepository({ client: { send }, tableName: "query-test" }),
  };
}

queryContract("DynamoDB shared query contract", (projections, activity) => {
  const fixture = sdkFixture();
  const putProjection = (record: (typeof projections)[number]) =>
    fixture.put(toProjectionItem(projectionInput(record)));
  projections.forEach(putProjection);
  activity.forEach((record) => fixture.put(toActivityItem(record)));
  return {
    repository: fixture.repository,
    putProjection,
    removeProjection: (record) => fixture.remove(projectionKey(projectionInput(record))),
    removeActivity: (record) => fixture.remove(activityKey(record)),
  };
});

describe("DynamoDB query SDK boundary", () => {
  it("defaults both SDK reads to 50 evaluated items and strong ascending reads", async () => {
    const send = vi.fn(async (command: { input: unknown }) => {
      expect(command).toBeInstanceOf(QueryCommand);
      return { Items: [] };
    });
    const repository = new DynamoDbRepository({ client: { send }, tableName: "query-test" });
    await repository.queryProjection({ projectionName: "contentItem.list" });
    await repository.queryActivity({ resourceType: "contentItem", resourceId: "content_1" });
    for (const [command] of send.mock.calls)
      expect(command.input).toMatchObject({
        Limit: 50,
        ConsistentRead: true,
        ScanIndexForward: true,
      });
    expect(
      send.mock.calls.map(
        ([command]) =>
          unmarshall((command.input as QueryCommandInput).ExpressionAttributeValues!)[":kind"],
      ),
    ).toEqual(["PROJECTION_ITEM", "ACTIVITY"]);
  });

  it("preserves empty activity-page continuation and rejects non-activity service keys", async () => {
    const fixture = sdkFixture(1);
    fixture.put(marshall({ ...activityKey(contractActivity("a")), itemKind: "AUXILIARY" }));
    fixture.put(toActivityItem(contractActivity("b")));
    const first = await fixture.repository.queryActivity({
      resourceType: "contentItem",
      resourceId: "content_1",
      limit: 1,
    });
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toBeTypeOf("string");
    expect(
      (
        await fixture.repository.queryActivity({
          resourceType: "contentItem",
          resourceId: "content_1",
          cursor: first.nextCursor!,
        })
      ).items.map((item) => item.activityId),
    ).toEqual(["b"]);
    const repository = new DynamoDbRepository({
      client: {
        send: async () => ({
          LastEvaluatedKey: marshall({ PK: "RES#contentItem#content_1", SK: "STATE" }),
        }),
      },
      tableName: "query-test",
    });
    await expect(
      repository.queryActivity({ resourceType: "contentItem", resourceId: "content_1" }),
    ).rejects.toMatchObject({ code: "runtime.internal" });
  });

  it("rejects a service cursor behind returned items or outside the starting range bound", async () => {
    const record = toProjectionItem(projectionInput(contractProjection("b", "b")));
    for (const response of [
      { Items: [record], LastEvaluatedKey: marshall({ PK: "PROJ#contentItem#list", SK: "a#id" }) },
      { Items: [], LastEvaluatedKey: marshall({ PK: "PROJ#contentItem#list", SK: "0#id" }) },
    ]) {
      const repository = new DynamoDbRepository({
        client: { send: async () => response },
        tableName: "query-test",
      });
      await expect(
        repository.queryProjection({
          projectionName: "contentItem.list",
          sortFrom: "a",
          sortBefore: "z",
        }),
      ).rejects.toMatchObject({ code: "runtime.internal" });
    }
  });

  it("preserves an empty filtered page's exact continuation and does not drain more pages internally", async () => {
    const fixture = sdkFixture(1);
    fixture.put(marshall({ PK: "PROJ#contentItem#list", SK: "a#filtered", itemKind: "AUXILIARY" }));
    fixture.put(toProjectionItem(projectionInput(contractProjection("b", "b"))));
    const first = await fixture.repository.queryProjection({
      projectionName: "contentItem.list",
      limit: 2,
    });
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toBeTypeOf("string");
    expect(fixture.send).toHaveBeenCalledTimes(1);
    const next = await fixture.repository.queryProjection({
      projectionName: "contentItem.list",
      cursor: first.nextCursor!,
      limit: 2,
    });
    expect(next.items.map((item) => item.itemId)).toEqual(["b"]);
    expect((fixture.send.mock.calls[1]![0].input as QueryCommandInput).ExclusiveStartKey).toEqual(
      marshall({ PK: "PROJ#contentItem#list", SK: "a#filtered" }),
    );
  });

  it("reconstructs only the known partition/start key and honors consistency/direction/limit", async () => {
    const send = vi.fn(async () => ({ Items: [] }));
    const repository = new DynamoDbRepository({
      client: { send },
      tableName: "custom-table",
      consistentRead: false,
    });
    const prepared = await prepareProjectionQuery({
      projectionName: "contentItem.status.approved",
      sortFrom: "a",
      sortBefore: "z",
      descending: true,
    });
    const cursor = prepared.cursorAfter("b#item_1");
    await repository.queryProjection({
      projectionName: "contentItem.status.approved",
      sortFrom: "a",
      sortBefore: "z",
      descending: true,
      limit: 7,
      cursor,
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TableName: "custom-table",
          Limit: 7,
          ConsistentRead: false,
          ScanIndexForward: false,
          KeyConditionExpression: "PK = :pk AND SK < :bound",
          ExclusiveStartKey: marshall({ PK: "PROJ#contentItem#status#approved", SK: "b#item_1" }),
        }),
      }),
    );
  });

  it("accepts memory cursors with changed page size without losing data", async () => {
    const memory = createInMemoryPersistence();
    const fixture = sdkFixture();
    for (const id of ["a", "b", "c", "d"]) {
      const record = contractProjection(id);
      memory.store.projections.set(id, record);
      fixture.put(toProjectionItem(projectionInput(record)));
    }
    const first = await memory.repository.queryProjection({
      projectionName: "contentItem.list",
      limit: 1,
    });
    const rest = await collectQuery((cursor) =>
      fixture.repository.queryProjection({
        projectionName: "contentItem.list",
        limit: 200,
        cursor: cursor ?? first.nextCursor!,
      }),
    );
    expect(rest.map((item) => item.itemId)).toEqual(["b", "c", "d"]);
  });

  it("validates bad queries and cursors before calling the SDK, including empty ranges", async () => {
    const fixture = sdkFixture();
    for (const query of [
      { projectionName: "invalid" },
      { projectionName: "contentItem.list", limit: 201 },
      { projectionName: "contentItem.list", cursor: "bad" },
      { projectionName: "contentItem.list", sortFrom: "z", sortBefore: "a" },
      { projectionName: "contentItem.list", sortFrom: "a", sortBefore: "a", cursor: "bad" },
    ])
      await expect(fixture.repository.queryProjection(query)).rejects.toMatchObject({
        code: "query.invalid",
      });
    await expect(
      fixture.repository.queryActivity({
        resourceType: "contentItem",
        resourceId: "content_1",
        cursor: "bad",
      }),
    ).rejects.toMatchObject({ code: "query.invalid" });
    expect(
      await fixture.repository.queryProjection({
        projectionName: "contentItem.list",
        sortBefore: "",
      }),
    ).toEqual({ items: [] });
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it.each([
    { PK: { S: "PROJ#foreign#list" }, SK: { S: "b#id" } },
    { PK: { S: "PROJ#contentItem#list" }, SK: { N: "1" } },
    { PK: { S: "PROJ#contentItem#list" }, SK: { S: "a#id" }, extra: { S: "key" } },
    { PK: { S: "PROJ#contentItem#list" }, SK: { S: "a#id", N: "1" } },
    { PK: { S: "PROJ#contentItem#list" }, SK: { S: "x".repeat(1025) } },
    { PK: { S: "PROJ#contentItem#list" }, SK: { S: "\uD800" } },
  ])("rejects invalid service continuation keys %#", async (LastEvaluatedKey) => {
    const repository = new DynamoDbRepository({
      client: { send: async () => ({ Items: [], LastEvaluatedKey }) },
      tableName: "query-test",
    });
    await expect(
      repository.queryProjection({ projectionName: "contentItem.list" }),
    ).rejects.toMatchObject({ code: "runtime.internal" });
  });

  it("rejects repeated/backwards service continuations instead of looping", async () => {
    const context = await prepareProjectionQuery({ projectionName: "contentItem.list" });
    const cursor = context.cursorAfter("b#id");
    for (const SK of ["a#id", "b#id"]) {
      const repository = new DynamoDbRepository({
        client: {
          send: async () => ({
            Items: [],
            LastEvaluatedKey: marshall({ PK: "PROJ#contentItem#list", SK }),
          }),
        },
        tableName: "query-test",
      });
      await expect(
        repository.queryProjection({ projectionName: "contentItem.list", cursor }),
      ).rejects.toMatchObject({ code: "runtime.internal" });
    }
  });

  it("rejects wrong-partition, mismatched physical keys, and out-of-order returned items", async () => {
    const a = toProjectionItem(projectionInput(contractProjection("a")));
    const b = toProjectionItem(projectionInput(contractProjection("b")));
    for (const Items of [
      [{ ...a, PK: { S: "PROJ#foreign#list" } }],
      [{ ...a, SK: { S: "a#wrong" } }],
      [b, a],
      [{ ...a, sort: { S: "wrong" } }],
    ]) {
      const repository = new DynamoDbRepository({
        client: { send: async () => ({ Items }) },
        tableName: "query-test",
      });
      await expect(
        repository.queryProjection({ projectionName: "contentItem.list" }),
      ).rejects.toMatchObject({ code: "runtime.internal" });
    }
  });

  it("stops at the far range boundary instead of emitting an out-of-range cursor", async () => {
    for (const descending of [false, true]) {
      const fixture = sdkFixture(2);
      for (const id of ["a", "b", "c", "d"])
        fixture.put(toProjectionItem(projectionInput(contractProjection(id, id))));
      const result = await collectQuery((cursor) =>
        fixture.repository.queryProjection({
          projectionName: "contentItem.list",
          sortFrom: "b",
          sortBefore: "d",
          descending,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        }),
      );
      expect(result.map((item) => item.itemId)).toEqual(descending ? ["c", "b"] : ["b", "c"]);
      expect(fixture.send.mock.calls.length).toBeLessThanOrEqual(2);
    }
  });

  it("propagates SDK failures rather than returning an empty success", async () => {
    const failure = new Error("unavailable");
    const repository = new DynamoDbRepository({
      client: {
        send: async () => {
          throw failure;
        },
      },
      tableName: "query-test",
    });
    await expect(repository.queryProjection({ projectionName: "contentItem.list" })).rejects.toBe(
      failure,
    );
    await expect(
      repository.queryActivity({ resourceType: "contentItem", resourceId: "content_1" }),
    ).rejects.toBe(failure);
  });
});
