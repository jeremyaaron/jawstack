import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { BatchWriteItemCommand, GetItemCommand, type WriteRequest } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  createInMemoryPersistence,
  type ActivityRecord,
  type CommandCommitInput,
  type Page,
  type ProjectionQuery,
  type ProjectionRecord,
  type QueryRepository,
  type ResourceState,
} from "@jawstack/core";
import {
  DynamoDbCommandUnitOfWork,
  DynamoDbRepository,
  projectionKey,
  toActivityItem,
  toProjectionItem,
} from "@jawstack/aws-runtime";
import { LabError, type LabConfig } from "./config";
import type { LabClients } from "./clients";

export async function writePagingFixtures(
  c: Pick<LabClients, "dynamo">,
  config: LabConfig,
  writes: readonly WriteRequest[],
) {
  for (let index = 0; index < writes.length; index += 25) {
    let pending = [...writes.slice(index, index + 25)];
    for (let attempt = 0; pending.length && attempt < 3; attempt++) {
      if (attempt) await delay(100 * attempt);
      const result = await c.dynamo.send(
        new BatchWriteItemCommand({ RequestItems: { [config.table]: pending } }),
      );
      if (Object.keys(result.UnprocessedItems ?? {}).some((table) => table !== config.table))
        throw new LabError("Unexpected table in fixture write response.");
      pending = result.UnprocessedItems?.[config.table] ?? [];
    }
    if (pending.length) throw new LabError("Paging fixture writes exceeded the retry budget.");
  }
}

async function collect<T>(read: (cursor?: string) => Promise<Page<T>>) {
  const items: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await read(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (++pages > 100 || (cursor !== undefined && cursors.has(cursor)))
      throw new LabError("Paging proof exceeded its page budget or repeated a cursor.");
    if (cursor !== undefined) cursors.add(cursor);
  } while (cursor !== undefined);
  return { items, pages };
}

export async function verifyPaging(c: LabClients, config: LabConfig) {
  const runId = randomUUID();
  const projectionName = `spineProof.paging.${runId}`;
  const resourceId = `paging_${runId}`;
  const instant = "2026-10-31T12:00:00.000Z";
  const memory = createInMemoryPersistence();
  const repository: QueryRepository = new DynamoDbRepository({
    client: c.dynamo,
    tableName: config.table,
  });
  const unitOfWork = new DynamoDbCommandUnitOfWork({ client: c.dynamo, tableName: config.table });
  const records: ProjectionRecord[] = Array.from({ length: 260 }, (_, i) => {
    const itemId = `item_${String(i).padStart(3, "0")}`;
    return {
      projectionName,
      itemId,
      sort: i % 2 ? instant : `${instant}#${itemId}`,
      data: { index: i, payload: "x".repeat(8192) },
    };
  });
  const activities: ActivityRecord[] = Array.from({ length: 17 }, (_, i) => ({
    resourceType: "spineProof",
    resourceId,
    activityId: `activity_${String(i).padStart(2, "0")}`,
    occurredAt: instant,
    activityType: "pagingProof",
    title: "Paging proof",
    correlationId: runId,
  }));
  const projectionInput = (record: ProjectionRecord) => ({
    ...record,
    resourceType: "spineProof",
    resourceId,
    updatedAt: instant,
  });
  await writePagingFixtures(c, config, [
    ...[...records]
      .reverse()
      .map((record) => ({ PutRequest: { Item: toProjectionItem(projectionInput(record)) } })),
    ...[...activities]
      .reverse()
      .map((record) => ({ PutRequest: { Item: toActivityItem(record) } })),
    {
      PutRequest: {
        Item: marshall({
          PK: projectionKey(projectionInput(records[0]!)).PK,
          SK: "!#filtered",
          itemKind: "PAGING_AUXILIARY",
        }),
      },
    },
  ]);
  for (const record of records) {
    await memory.unitOfWork.commit({
      resource: {
        resourceType: "spineProof",
        resourceId: record.itemId,
        create: true,
        next: {
          resourceType: "spineProof",
          resourceId: record.itemId,
          version: 1,
          state: {},
          createdAt: instant,
          updatedAt: instant,
          createdBy: "lab_user",
          updatedBy: "lab_user",
        },
      },
      activity: [],
      outbox: [],
      projections: [record],
      response: {},
    });
  }
  memory.store.activity.push(...structuredClone(activities).reverse());
  const all = (repo: QueryRepository, query: ProjectionQuery) =>
    collect((cursor) =>
      repo.queryProjection({ ...query, ...(cursor === undefined ? {} : { cursor }) }),
    );
  const check = async (query: ProjectionQuery) => {
    const actual = await all(repository, query);
    const expected = await all(memory.repository, query);
    if (!isDeepStrictEqual(actual.items, expected.items))
      throw new LabError("Live projection paging disagreed with memory.");
    return actual;
  };
  const first = await repository.queryProjection({ projectionName, limit: 200 });
  if (first.items.length === 0 || first.items.length >= 199 || !first.nextCursor)
    throw new LabError(
      "Large paging dataset did not produce a service-shortened page with continuation.",
    );
  const empty = await repository.queryProjection({ projectionName, limit: 1 });
  if (empty.items.length || !empty.nextCursor)
    throw new LabError("Live empty filtered page lost its continuation.");
  const afterEmpty = await all(repository, { projectionName, limit: 37, cursor: empty.nextCursor });
  if (
    !isDeepStrictEqual(
      afterEmpty.items,
      (await all(memory.repository, { projectionName, limit: 37 })).items,
    )
  )
    throw new LabError("Live continuation after an empty page lost records.");
  let cases = 0;
  for (const descending of [false, true]) {
    for (const bounds of [
      {},
      { sortFrom: `${instant}#item_064`, sortBefore: `${instant}#item_128` },
      { sortFrom: `${instant}#item_128`, sortBefore: `${instant}#item_128` },
      { sortBefore: "" },
    ]) {
      await check({ projectionName, limit: 37, descending, ...bounds });
      cases++;
    }
  }
  const actualActivity = await collect((cursor) =>
    repository.queryActivity({
      resourceType: "spineProof",
      resourceId,
      limit: 3,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
  const expectedActivity = await collect((cursor) =>
    memory.repository.queryActivity({
      resourceType: "spineProof",
      resourceId,
      limit: 3,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
  if (!isDeepStrictEqual(actualActivity.items, expectedActivity.items))
    throw new LabError("Live activity paging disagreed with memory.");

  const previous = records[0]!;
  const moved = { ...previous, sort: "2026-11-01T00:00:00.000Z#item_000" };
  const state: ResourceState = {
    resourceType: "spineProof",
    resourceId,
    version: 1,
    state: {},
    createdAt: instant,
    updatedAt: instant,
    createdBy: "lab_user",
    updatedBy: "lab_user",
  };
  const commit = async (input: CommandCommitInput) => {
    await unitOfWork.commit(input);
    await memory.unitOfWork.commit(input);
  };
  await commit({
    resource: { resourceType: "spineProof", resourceId, create: true, next: state },
    activity: [],
    outbox: [],
    projections: [],
    response: {},
  });
  await commit({
    resource: {
      resourceType: "spineProof",
      resourceId,
      create: false,
      expectedVersion: 1,
      next: { ...state, version: 2 },
    },
    activity: [],
    outbox: [],
    projections: [{ ...previous, delete: true }, moved],
    response: {},
  });
  const oldKey = projectionKey(projectionInput(previous));
  if (
    (
      await c.dynamo.send(
        new GetItemCommand({
          TableName: config.table,
          Key: marshall(oldKey),
          ConsistentRead: true,
        }),
      )
    ).Item
  )
    throw new LabError("Projection movement left its old physical key behind.");
  await check({ projectionName, limit: 37 });
  const relocated = { ...moved, projectionName: `${projectionName}.approved` };
  await commit({
    resource: {
      resourceType: "spineProof",
      resourceId,
      create: false,
      expectedVersion: 2,
      next: { ...state, version: 3 },
    },
    activity: [],
    outbox: [],
    projections: [{ ...moved, delete: true }, relocated],
    response: {},
  });
  await check({ projectionName, limit: 37 });
  const relocatedPage = await check({ projectionName: relocated.projectionName, limit: 37 });
  if (relocatedPage.items.length !== 1)
    throw new LabError("Projection partition move did not retain exactly one item.");

  const deleted = await repository.queryProjection({ projectionName, limit: 1, descending: true });
  const boundary = deleted.items[0]!;
  await commit({
    resource: {
      resourceType: "spineProof",
      resourceId,
      create: false,
      expectedVersion: 3,
      next: { ...state, version: 4 },
    },
    activity: [],
    outbox: [],
    projections: [{ ...boundary, delete: true }],
    response: {},
  });
  const continued = await all(repository, {
    projectionName,
    limit: 37,
    descending: true,
    cursor: deleted.nextCursor!,
  });
  const expectedContinued = await all(memory.repository, {
    projectionName,
    limit: 37,
    descending: true,
    cursor: deleted.nextCursor!,
  });
  if (!isDeepStrictEqual(continued.items, expectedContinued.items))
    throw new LabError("Live deleted-boundary continuation disagreed with memory.");
  return {
    runId,
    projectionName,
    projectionRecords: records.length,
    payloadBytesPerRecord: 8192,
    serviceLimitedFirstPageItems: first.items.length,
    emptyFilteredContinuation: true,
    rangeDirectionCases: cases,
    activityRecords: activities.length,
    activityPages: actualActivity.pages,
    transactionalSortMove: true,
    transactionalPartitionMove: true,
    deletedBoundaryContinuation: true,
    memoryParity: "passed",
  };
}
