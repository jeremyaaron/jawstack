import type { AttributeValue, TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type {
  ActivityRecord,
  ApiSuccess,
  CommandCommitInput,
  IdempotencyCommit,
  JawStackEvent,
  ProjectionWrite,
  ResourceState,
} from "@jawstack/core";

export const packageName = "@jawstack/aws-runtime";

export function describePackage(): string {
  return `${packageName} DynamoDB runtime helpers`;
}

export type DynamoDbItem = Record<string, AttributeValue>;

export type DynamoDbKey = Readonly<{
  PK: string;
  SK: string;
}>;

export type DynamoDbOutboxStatus = "PENDING" | "PUBLISHED" | "FAILED";

export type DynamoDbItemKind =
  | "RESOURCE_STATE"
  | "ACTIVITY"
  | "OUTBOX_EVENT"
  | "IDEMPOTENCY_RECORD"
  | "PROJECTION_ITEM"
  | "WORKER_IDEMPOTENCY";

export type DynamoDbResourceStateItem<TState = unknown> = DynamoDbKey &
  ResourceState<TState> &
  Readonly<{
    itemKind: "RESOURCE_STATE";
  }>;

export type DynamoDbActivityItem = DynamoDbKey &
  ActivityRecord &
  Readonly<{
    itemKind: "ACTIVITY";
  }>;

export type DynamoDbOutboxEventItem<TPayload = unknown> = DynamoDbKey &
  Readonly<{
    GSI1PK: string;
    GSI1SK: string;
    itemKind: "OUTBOX_EVENT";
    eventId: string;
    status: DynamoDbOutboxStatus;
    event: JawStackEvent<TPayload>;
    attempts: number;
    createdAt: string;
    updatedAt: string;
    publishedAt?: string;
    lastError?: string;
  }>;

export type DynamoDbIdempotencyItem<TResponse = unknown> = DynamoDbKey &
  Readonly<{
    itemKind: "IDEMPOTENCY_RECORD";
    resourceType: string;
    commandName: string;
    subject: string;
    idempotencyKey: string;
    payloadHash: string;
    resourceId?: string;
    response: ApiSuccess<TResponse>;
    statusCode: number;
    createdAt: string;
    expiresAt: number;
  }>;

export type DynamoDbIdempotencyContext = Readonly<{
  resourceType: string;
  commandName: string;
  subject: string;
  idempotencyKey: string;
  payloadHash: string;
  createdAt: string;
  expiresAt: number;
  resourceId?: string;
  statusCode?: number;
}>;

export type DynamoDbProjectionItem = DynamoDbKey &
  Readonly<{
    itemKind: "PROJECTION_ITEM";
    resourceType: string;
    projectionName: string;
    itemId: string;
    sort: string;
    data: Record<string, unknown>;
    resourceId: string;
    tenantId?: string;
    updatedAt: string;
  }>;

export type DynamoDbProjectionInput = ProjectionWrite &
  Readonly<{
    resourceType: string;
    resourceId: string;
    tenantId?: string;
    updatedAt: string;
  }>;

export type DynamoDbWorkerIdempotencyItem = DynamoDbKey &
  Readonly<{
    itemKind: "WORKER_IDEMPOTENCY";
    workerName: string;
    eventId: string;
    processedAt: string;
    expiresAt: number;
  }>;

export type DynamoDbCommandTransactionOptions = Readonly<{
  tableName: string;
  idempotency?: Readonly<{
    commandName: string;
    subject?: string;
    createdAt?: string;
    expiresAt?: number;
    statusCode?: number;
  }>;
}>;

const INVERTED_TIMESTAMP_MAX = 9_999_999_999_999;
const INVERTED_TIMESTAMP_WIDTH = 13;
const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

export function resourceStateKey(resourceType: string, resourceId: string): DynamoDbKey {
  return {
    PK: `RES#${resourceType}#${resourceId}`,
    SK: "STATE",
  };
}

export function activityKey(
  input: Pick<ActivityRecord, "resourceType" | "resourceId" | "occurredAt" | "activityId">,
): DynamoDbKey {
  return {
    PK: `RES#${input.resourceType}#${input.resourceId}`,
    SK: `ACT#${input.occurredAt}#${input.activityId}`,
  };
}

export function outboxEventKey(eventId: string): DynamoDbKey {
  return {
    PK: `OUTBOX#${eventId}`,
    SK: "EVENT",
  };
}

export function outboxStatusKey(
  status: DynamoDbOutboxStatus,
  createdAt: string,
  eventId: string,
): Readonly<{
  GSI1PK: string;
  GSI1SK: string;
}> {
  return {
    GSI1PK: `OUTBOX#${status}`,
    GSI1SK: `${createdAt}#${eventId}`,
  };
}

export function idempotencyKey(
  input: Pick<
    DynamoDbIdempotencyContext,
    "resourceType" | "commandName" | "subject" | "idempotencyKey"
  >,
): DynamoDbKey {
  return {
    PK: `IDEMP#${input.resourceType}#${input.commandName}#${input.subject}`,
    SK: input.idempotencyKey,
  };
}

export function projectionKey(
  input: Pick<DynamoDbProjectionInput, "resourceType" | "projectionName" | "sort" | "itemId">,
): DynamoDbKey {
  const projectionName = projectionNameKeySegment(input.resourceType, input.projectionName);

  return {
    PK: `PROJ#${input.resourceType}#${projectionName}`,
    SK: projectionSortKey(input.sort, input.itemId),
  };
}

export function workerIdempotencyKey(workerName: string, eventId: string): DynamoDbKey {
  return {
    PK: `WORKER#${workerName}#PROCESSED`,
    SK: eventId,
  };
}

export function invertedTimestamp(timestamp: string | Date): string {
  const epochMillis = timestamp instanceof Date ? timestamp.getTime() : Date.parse(timestamp);

  if (!Number.isFinite(epochMillis)) {
    throw new RangeError(`Invalid timestamp: ${String(timestamp)}`);
  }

  const inverted = INVERTED_TIMESTAMP_MAX - epochMillis;

  if (inverted < 0) {
    throw new RangeError(
      `Timestamp is outside the supported inverted sort range: ${String(timestamp)}`,
    );
  }

  return String(inverted).padStart(INVERTED_TIMESTAMP_WIDTH, "0");
}

export function toResourceStateItem<TState = unknown>(state: ResourceState<TState>): DynamoDbItem {
  return marshallItem({
    ...resourceStateKey(state.resourceType, state.resourceId),
    itemKind: "RESOURCE_STATE",
    ...state,
  } satisfies DynamoDbResourceStateItem<TState>);
}

export function fromResourceStateItem<TState = unknown>(item: DynamoDbItem): ResourceState<TState> {
  const unmarshalled = unmarshallItem<DynamoDbResourceStateItem<TState>>(item);

  return {
    resourceType: unmarshalled.resourceType,
    resourceId: unmarshalled.resourceId,
    version: unmarshalled.version,
    state: unmarshalled.state,
    createdAt: unmarshalled.createdAt,
    updatedAt: unmarshalled.updatedAt,
    createdBy: unmarshalled.createdBy,
    updatedBy: unmarshalled.updatedBy,
    ...(unmarshalled.tenantId === undefined ? {} : { tenantId: unmarshalled.tenantId }),
  };
}

export function toActivityItem(record: ActivityRecord): DynamoDbItem {
  return marshallItem({
    ...activityKey(record),
    itemKind: "ACTIVITY",
    ...record,
  } satisfies DynamoDbActivityItem);
}

export function fromActivityItem(item: DynamoDbItem): ActivityRecord {
  const unmarshalled = unmarshallItem<DynamoDbActivityItem>(item);

  return {
    activityId: unmarshalled.activityId,
    resourceType: unmarshalled.resourceType,
    resourceId: unmarshalled.resourceId,
    activityType: unmarshalled.activityType,
    title: unmarshalled.title,
    ...(unmarshalled.summary === undefined ? {} : { summary: unmarshalled.summary }),
    ...(unmarshalled.data === undefined ? {} : { data: unmarshalled.data }),
    ...(unmarshalled.actor === undefined ? {} : { actor: unmarshalled.actor }),
    ...(unmarshalled.tenantId === undefined ? {} : { tenantId: unmarshalled.tenantId }),
    correlationId: unmarshalled.correlationId,
    ...(unmarshalled.causationId === undefined ? {} : { causationId: unmarshalled.causationId }),
    occurredAt: unmarshalled.occurredAt,
  };
}

export function toOutboxEventItem<TPayload = unknown>(
  event: JawStackEvent<TPayload>,
  options: Partial<
    Pick<
      DynamoDbOutboxEventItem<TPayload>,
      "status" | "attempts" | "createdAt" | "updatedAt" | "publishedAt" | "lastError"
    >
  > = {},
): DynamoDbItem {
  const status = options.status ?? "PENDING";
  const createdAt = options.createdAt ?? event.occurredAt;
  const updatedAt = options.updatedAt ?? createdAt;

  return marshallItem({
    ...outboxEventKey(event.eventId),
    ...outboxStatusKey(status, createdAt, event.eventId),
    itemKind: "OUTBOX_EVENT",
    eventId: event.eventId,
    status,
    event,
    attempts: options.attempts ?? 0,
    createdAt,
    updatedAt,
    ...(options.publishedAt === undefined ? {} : { publishedAt: options.publishedAt }),
    ...(options.lastError === undefined ? {} : { lastError: options.lastError }),
  } satisfies DynamoDbOutboxEventItem<TPayload>);
}

export function fromOutboxEventItem<TPayload = unknown>(
  item: DynamoDbItem,
): DynamoDbOutboxEventItem<TPayload> {
  return unmarshallItem<DynamoDbOutboxEventItem<TPayload>>(item);
}

export function toIdempotencyItem<TResponse = unknown>(
  context: DynamoDbIdempotencyContext,
  response: ApiSuccess<TResponse>,
): DynamoDbItem {
  return marshallItem({
    ...idempotencyKey(context),
    itemKind: "IDEMPOTENCY_RECORD",
    resourceType: context.resourceType,
    commandName: context.commandName,
    subject: context.subject,
    idempotencyKey: context.idempotencyKey,
    payloadHash: context.payloadHash,
    ...(context.resourceId === undefined ? {} : { resourceId: context.resourceId }),
    response,
    statusCode: context.statusCode ?? 200,
    createdAt: context.createdAt,
    expiresAt: context.expiresAt,
  } satisfies DynamoDbIdempotencyItem<TResponse>);
}

export function idempotencyContextFromCoreRecord<TResponse = unknown>(
  record: IdempotencyCommit<TResponse>,
  context: Readonly<{
    resourceType: string;
    commandName: string;
    subject: string;
    createdAt: string;
    resourceId?: string;
    expiresAt?: number;
    ttlSeconds?: number;
    statusCode?: number;
  }>,
): DynamoDbIdempotencyContext {
  const ttlSeconds = context.ttlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS;
  const expiresAt =
    context.expiresAt ?? Math.floor(Date.parse(context.createdAt) / 1000) + ttlSeconds;

  return {
    resourceType: context.resourceType,
    commandName: context.commandName,
    subject: context.subject,
    idempotencyKey: record.key,
    payloadHash: record.fingerprint,
    createdAt: context.createdAt,
    expiresAt,
    ...(context.resourceId === undefined ? {} : { resourceId: context.resourceId }),
    ...(context.statusCode === undefined ? {} : { statusCode: context.statusCode }),
  };
}

export function fromIdempotencyItem<TResponse = unknown>(
  item: DynamoDbItem,
): DynamoDbIdempotencyItem<TResponse> {
  return unmarshallItem<DynamoDbIdempotencyItem<TResponse>>(item);
}

export function toProjectionItem(input: DynamoDbProjectionInput): DynamoDbItem {
  return marshallItem({
    ...projectionKey(input),
    itemKind: "PROJECTION_ITEM",
    resourceType: input.resourceType,
    projectionName: input.projectionName,
    itemId: input.itemId,
    sort: input.sort,
    data: input.data,
    resourceId: input.resourceId,
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    updatedAt: input.updatedAt,
  } satisfies DynamoDbProjectionItem);
}

export function fromProjectionItem(item: DynamoDbItem): DynamoDbProjectionItem {
  return unmarshallItem<DynamoDbProjectionItem>(item);
}

export function toWorkerIdempotencyItem(
  input: Readonly<{
    workerName: string;
    eventId: string;
    processedAt: string;
    expiresAt: number;
  }>,
): DynamoDbItem {
  return marshallItem({
    ...workerIdempotencyKey(input.workerName, input.eventId),
    itemKind: "WORKER_IDEMPOTENCY",
    workerName: input.workerName,
    eventId: input.eventId,
    processedAt: input.processedAt,
    expiresAt: input.expiresAt,
  } satisfies DynamoDbWorkerIdempotencyItem);
}

export function fromWorkerIdempotencyItem(item: DynamoDbItem): DynamoDbWorkerIdempotencyItem {
  return unmarshallItem<DynamoDbWorkerIdempotencyItem>(item);
}

export function buildCommandTransactWriteItems<TState = unknown, TResponse = unknown>(
  input: CommandCommitInput<TState, TResponse>,
  options: DynamoDbCommandTransactionOptions,
): TransactWriteItem[] {
  const items: TransactWriteItem[] = [
    buildResourceStateTransactWriteItem(input.resource, options.tableName),
    ...input.activity.map((record) => buildPut(toActivityItem(record), options.tableName)),
    ...input.outbox.map((event) => buildPut(toOutboxEventItem(event), options.tableName)),
    ...input.projections.map((projection) =>
      buildProjectionTransactWriteItem(
        projection,
        {
          resourceType: input.resource.resourceType,
          resourceId: input.resource.resourceId,
          updatedAt: input.resource.next.updatedAt,
          ...(input.resource.next.tenantId === undefined
            ? {}
            : { tenantId: input.resource.next.tenantId }),
        },
        options.tableName,
      ),
    ),
  ];

  if (input.idempotency !== undefined) {
    items.push(
      buildPut(
        toIdempotencyItem(
          idempotencyContextFromCoreRecord(input.idempotency, {
            resourceType: input.resource.resourceType,
            commandName: requireCommandName(options),
            subject: options.idempotency?.subject ?? input.resource.next.updatedBy,
            createdAt: options.idempotency?.createdAt ?? input.resource.next.updatedAt,
            resourceId: input.resource.resourceId,
            ...(options.idempotency?.expiresAt === undefined
              ? {}
              : { expiresAt: options.idempotency.expiresAt }),
            ...(options.idempotency?.statusCode === undefined
              ? {}
              : { statusCode: options.idempotency.statusCode }),
          }),
          input.idempotency.response,
        ),
        options.tableName,
        "attribute_not_exists(PK)",
      ),
    );
  }

  return items;
}

export function buildResourceStateTransactWriteItem<TState = unknown>(
  resource: CommandCommitInput<TState>["resource"],
  tableName: string,
): TransactWriteItem {
  const condition = resource.create ? "attribute_not_exists(PK)" : "#version = :expectedVersion";

  return buildPut(toResourceStateItem(resource.next), tableName, condition, {
    ...(resource.create
      ? {}
      : {
          ExpressionAttributeNames: {
            "#version": "version",
          },
          ExpressionAttributeValues: marshallItem({
            ":expectedVersion": resource.expectedVersion,
          }),
        }),
  });
}

export function buildProjectionTransactWriteItem(
  projection: ProjectionWrite,
  context: Readonly<{
    resourceType: string;
    resourceId: string;
    tenantId?: string;
    updatedAt: string;
  }>,
  tableName: string,
): TransactWriteItem {
  const projectionInput: DynamoDbProjectionInput = {
    ...projection,
    resourceType: context.resourceType,
    resourceId: context.resourceId,
    ...(context.tenantId === undefined ? {} : { tenantId: context.tenantId }),
    updatedAt: context.updatedAt,
  };

  if (projection.delete === true) {
    return {
      Delete: {
        TableName: tableName,
        Key: marshallItem(projectionKey(projectionInput)),
      },
    };
  }

  return buildPut(toProjectionItem(projectionInput), tableName);
}

function buildPut(
  item: DynamoDbItem,
  tableName: string,
  conditionExpression?: string,
  overrides: Partial<NonNullable<TransactWriteItem["Put"]>> = {},
): TransactWriteItem {
  return {
    Put: {
      TableName: tableName,
      Item: item,
      ...(conditionExpression === undefined ? {} : { ConditionExpression: conditionExpression }),
      ...overrides,
    },
  };
}

function projectionNameKeySegment(resourceType: string, projectionName: string): string {
  const resourcePrefix = `${resourceType}.`;
  const localName = projectionName.startsWith(resourcePrefix)
    ? projectionName.slice(resourcePrefix.length)
    : projectionName;

  return localName.replaceAll(".", "#");
}

function projectionSortKey(sort: string, itemId: string): string {
  return sort.endsWith(`#${itemId}`) ? sort : `${sort}#${itemId}`;
}

function requireCommandName(options: DynamoDbCommandTransactionOptions): string {
  if (options.idempotency?.commandName === undefined) {
    throw new Error(
      "DynamoDB idempotency transaction items require options.idempotency.commandName.",
    );
  }

  return options.idempotency.commandName;
}

function marshallItem(value: Record<string, unknown>): DynamoDbItem {
  return marshall(value, { removeUndefinedValues: true }) as DynamoDbItem;
}

function unmarshallItem<T>(item: DynamoDbItem): T {
  return unmarshall(item) as T;
}
