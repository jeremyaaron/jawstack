import { isDeepStrictEqual as equal } from "node:util";
import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type GetItemCommandOutput,
  type QueryCommandOutput,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  JawStackRuntimeError,
  type IdempotencyRecord,
  type WorkflowCommandScope,
  type WorkflowStorage,
  type WorkflowStorageSpec,
  type WorkflowFailureStore,
} from "@jawstack/core";
import {
  DynamoDbRepository,
  activityKey,
  idempotencyKey,
  projectionKey,
  resourceStateKey,
  toOutboxEventItem,
  toProjectionItem,
  toWorkerIdempotencyItem,
  workerIdempotencyKey,
  type DynamoDbClientLike,
  type DynamoDbItem,
  type DynamoDbKey,
} from "../index";
import {
  absent,
  boundedTransaction,
  compileWorkflowCommit,
  expired,
  transactionError,
  version,
} from "./compiler";

function invalid(): never {
  throw new JawStackRuntimeError("resource.invalid_state", "Stored workflow record is invalid.");
}
function conflict(): never {
  throw new JawStackRuntimeError("resource.conflict", "Workflow condition failed.");
}
const unavailable = (): never => {
  throw new JawStackRuntimeError("runtime.unavailable", "Workflow storage is unavailable.");
};
const component = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  Date.parse(value) >= 0 &&
  new Date(value).toISOString() === value;
function fields(row: Record<string, unknown>, names: readonly string[]) {
  if (Object.keys(row).some((key) => !names.includes(key))) invalid();
}

export function createDynamoWorkflowStorage(
  spec: WorkflowStorageSpec,
  client: DynamoDbClientLike,
  tableName: string,
): WorkflowStorage {
  const send = client.send.bind(client);
  const request = async <T>(command: { input: unknown }): Promise<T> => {
    try {
      return (await send(command)) as T;
    } catch (error) {
      if (error instanceof JawStackRuntimeError) throw error;
      return unavailable();
    }
  };
  const raw = (item: DynamoDbItem, key?: DynamoDbKey, kind?: string): Record<string, unknown> => {
    try {
      const row = spec.validation.json(unmarshall(item), 400 * 1024);
      if (
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        typeof row.PK !== "string" ||
        typeof row.SK !== "string" ||
        (key && (row.PK !== key.PK || row.SK !== key.SK)) ||
        (kind && row.itemKind !== kind) ||
        "tenantId" in row
      )
        invalid();
      return row as Record<string, unknown>;
    } catch {
      return invalid();
    }
  };
  const body = (row: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(row).filter(([key]) => !["PK", "SK", "itemKind"].includes(key)),
    );
  const get = async (key: DynamoDbKey, kind: string) => {
    const output = await request<GetItemCommandOutput>(
      new GetItemCommand({ TableName: tableName, Key: marshall(key), ConsistentRead: true }),
    );
    return output.Item === undefined ? undefined : raw(output.Item, key, kind);
  };
  const getState: WorkflowStorage["repository"]["getState"] = async <T>(
    type: string,
    id: string,
  ) => {
    const row = await get(resourceStateKey(type, id), "RESOURCE_STATE");
    return row === undefined
      ? undefined
      : (spec.validation.resource(
          body(row),
          type,
          id,
        ) as import("@jawstack/core").ResourceState<T>);
  };
  const getIdempotency = async (
    scope: WorkflowCommandScope,
    key: string,
    nowSeconds: number,
  ): Promise<IdempotencyRecord | undefined> => {
    const row = await get(idempotencyKey({ ...scope, idempotencyKey: key }), "IDEMPOTENCY_RECORD");
    if (!row) return undefined;
    fields(row, [
      "PK",
      "SK",
      "itemKind",
      "resourceType",
      "commandName",
      "subject",
      "idempotencyKey",
      "payloadHash",
      "resourceId",
      "response",
      "statusCode",
      "createdAt",
      "expiresAt",
    ]);
    if (!component(row.resourceId) || row.statusCode !== 200) invalid();
    const stored = spec.validation.idempotency(
      {
        key: row.idempotencyKey,
        fingerprint: row.payloadHash,
        response: row.response,
        resourceType: row.resourceType,
        commandName: row.commandName,
        subject: row.subject,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      },
      scope,
      key,
    );
    if (stored.expiresAt <= nowSeconds) return undefined;
    return { key: stored.key, fingerprint: stored.fingerprint, response: stored.response };
  };
  const projection = (row: Record<string, unknown>) => {
    fields(row, [
      "PK",
      "SK",
      "itemKind",
      "resourceType",
      "resourceId",
      "projectionName",
      "itemId",
      "sort",
      "data",
      "updatedAt",
    ]);
    if (
      !component(row.resourceType) ||
      !spec.manifest.resources.includes(row.resourceType) ||
      !component(row.resourceId) ||
      !instant(row.updatedAt)
    )
      invalid();
    const value = spec.validation.projection({
      projectionName: row.projectionName,
      itemId: row.itemId,
      sort: row.sort,
      data: row.data,
    });
    const key = projectionKey({ ...value, resourceType: row.resourceType });
    if (row.itemKind !== "PROJECTION_ITEM" || row.PK !== key.PK || row.SK !== key.SK) invalid();
    if (value.projectionName === spec.protocol.projectionName) {
      const summary = spec.protocol.parseSummary(value.data);
      if (
        value.itemId !== summary.id ||
        value.sort !== `${summary.firstCollectedAt}#${summary.id}` ||
        row.resourceType !== spec.protocol.resourceType ||
        row.resourceId !== summary.resourceId ||
        row.updatedAt !== summary.firstCollectedAt
      )
        invalid();
    }
    return value;
  };
  const queryClient: DynamoDbClientLike = {
    send: async (command) => {
      if (!(command instanceof QueryCommand)) return unavailable();
      const output = await request<QueryCommandOutput>(command);
      for (const item of output.Items ?? []) {
        const row = raw(item);
        if (row.PK !== command.input.ExpressionAttributeValues?.[":pk"]?.S) invalid();
        if (command.input.ExpressionAttributeValues?.[":kind"]?.S === "PROJECTION_ITEM")
          projection(row);
        else {
          if (row.itemKind !== "ACTIVITY") invalid();
          const value = spec.validation.activity(body(row));
          const key = activityKey(value);
          if (row.PK !== key.PK || row.SK !== key.SK) invalid();
        }
      }
      return output;
    },
  };
  const queries = new DynamoDbRepository({ client: queryClient, tableName, consistentRead: true });
  const transact = async (compiled: ReturnType<typeof boundedTransaction>) => {
    try {
      await send(new TransactWriteItemsCommand(compiled.input));
    } catch (error) {
      transactionError(error, compiled.roles);
    }
  };
  const failures: WorkflowFailureStore = {
    get: async (id) => {
      const key = spec.protocol.key(id);
      const row = await get({ PK: key.partition, SK: key.sort }, "APP_FAILURE");
      if (row === undefined) return undefined;
      const record = spec.protocol.parse(body(row));
      if (record.id !== id) invalid();
      return record;
    },
    query: (input) => queries.queryProjection(spec.protocol.query(input)),
    commit: async (expectedVersion, input, replay) => {
      const next = spec.protocol.parse(input);
      const event = replay === undefined ? undefined : spec.protocol.wire(replay);
      const old = await failures.get(next.id);
      if ((old?.version ?? null) !== expectedVersion) conflict();
      spec.protocol.validateChange(old, next, event);
      const value = spec.protocol.projection(next);
      const key = projectionKey({ ...value, resourceType: spec.protocol.resourceType });
      const prior = await get(key, "PROJECTION_ITEM");
      if (old) {
        if (!prior || !equal(projection(prior), spec.protocol.projection(old))) {
          // Another compliant writer can move both rows between our strong reads.
          if ((await failures.get(next.id))?.version !== old.version) conflict();
          invalid();
        }
      } else if (prior) {
        projection(prior);
        conflict();
      }
      const failureKey = spec.protocol.key(next.id);
      const items: TransactWriteItem[] = [
        {
          Put: {
            TableName: tableName,
            Item: marshall({
              PK: failureKey.partition,
              SK: failureKey.sort,
              itemKind: "APP_FAILURE",
              ...next,
            }),
            ...(expectedVersion === null ? absent : version(expectedVersion)),
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: toProjectionItem({
              ...value,
              resourceType: spec.protocol.resourceType,
              resourceId: next.original.resourceId,
              updatedAt: next.firstCollectedAt,
            }),
            ...(old ? {} : absent),
          },
        },
      ];
      if (event)
        items.push({ Put: { TableName: tableName, Item: toOutboxEventItem(event), ...absent } });
      await transact(
        boundedTransaction(
          items,
          items.map(() => "resource"),
        ),
      );
    },
  };
  const marker = async (name: string, eventId: string, now: Date) => {
    if (!Number.isFinite(now.getTime()) || now.getTime() < 0)
      throw new JawStackRuntimeError("command.rejected", "Invalid workflow clock.");
    const row = await get(workerIdempotencyKey(name, eventId), "WORKER_IDEMPOTENCY");
    if (!row) return false;
    fields(row, ["PK", "SK", "itemKind", "workerName", "eventId", "processedAt", "expiresAt"]);
    if (
      row.workerName !== name ||
      row.eventId !== eventId ||
      !instant(row.processedAt) ||
      !Number.isSafeInteger(row.expiresAt) ||
      (row.expiresAt as number) <= Math.floor(Date.parse(row.processedAt) / 1000) ||
      (row.expiresAt as number) > Math.floor(Date.parse(row.processedAt) / 1000) + 604800
    )
      invalid();
    return (row.expiresAt as number) > Math.floor(now.getTime() / 1000);
  };
  return Object.freeze<WorkflowStorage>({
    command: (inputScope, inputTime) => {
      const scope = Object.freeze({ ...inputScope }),
        now = inputTime.toISOString();
      const nowSeconds = Math.floor(Date.parse(now) / 1000);
      return {
        repository: { getState, getIdempotency: (key) => getIdempotency(scope, key, nowSeconds) },
        unitOfWork: {
          commit: async (commit) => {
            const plan = spec.planner.plan({ scope, now }, commit);
            const compiled = compileWorkflowCommit(spec.planner, plan, tableName);
            let deletedBytes = 0;
            // Validate existing replaceable rows even on create, without substituting a
            // read/check/write protocol for the authoritative transaction conditions.
            for (const action of plan.actions) {
              if (action.kind === "resource")
                await getState(action.value.resourceType, action.value.resourceId);
              else if (action.kind === "idempotency")
                await getIdempotency(scope, action.value.key, nowSeconds);
              else if (action.kind === "projection" || action.kind === "projectionDelete") {
                const row = await get(
                  { PK: action.key.partition, SK: action.key.sort },
                  "PROJECTION_ITEM",
                );
                if (row) {
                  projection(row);
                  if (action.kind === "projectionDelete")
                    deletedBytes += Buffer.byteLength(JSON.stringify(marshall(row)));
                }
              }
            }
            await transact(
              deletedBytes
                ? boundedTransaction(
                    compiled.input.TransactItems!,
                    [...compiled.roles],
                    deletedBytes,
                  )
                : compiled,
            );
          },
        },
      };
    },
    repository: { getState },
    queries,
    records: {
      get: async (collection, logicalKey) => {
        const row = await get({ PK: `OPS#${collection}`, SK: logicalKey }, "APP_OPERATION");
        return row === undefined
          ? undefined
          : spec.validation.record(collection, logicalKey, body(row));
      },
    },
    failures,
    markers: {
      check: async (name, event, now) =>
        (await marker(name, event.eventId, now)) ? "processed" : "available",
      write: async (name, event, now) => {
        if (await marker(name, event.eventId, now)) return;
        try {
          await send(
            new PutItemCommand({
              TableName: tableName,
              Item: toWorkerIdempotencyItem({
                workerName: name,
                eventId: event.eventId,
                processedAt: now.toISOString(),
                expiresAt: Math.floor(now.getTime() / 1000) + 604800,
              }),
              ...expired(Math.floor(now.getTime() / 1000)),
            }),
          );
        } catch {
          // A concurrent or uncertain successful write is usable only after a strong,
          // validated read. Markers deduplicate completion; they never lock handlers.
          if (!(await marker(name, event.eventId, now))) unavailable();
        }
      },
    },
  });
}
