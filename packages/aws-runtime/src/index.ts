import {
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type QueryCommandOutput,
  type TransactWriteItem,
  type TransactWriteItemsCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type {
  ActivityRecord,
  ApiSuccess,
  CommandCommitInput,
  CommandUnitOfWork,
  IdempotencyCommit,
  IdempotencyRecord,
  JawStackEvent,
  LocalHttpReadableRepository,
  ProjectionWrite,
  ResourceState,
} from "@jawstack/core";
import { JawStackRuntimeError } from "@jawstack/core";

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

export type DynamoDbClientLike = Readonly<{
  send(command: DynamoDbCommand): Promise<unknown>;
}>;

export type DynamoDbCommand = Readonly<{
  input: unknown;
}>;

export type DynamoDbRepositoryOptions = Readonly<{
  client: DynamoDbClientLike;
  tableName: string;
  consistentRead?: boolean;
  idempotencyScope?: DynamoDbIdempotencyScope;
}>;

export type DynamoDbIdempotencyScope = Readonly<{
  resourceType: string;
  commandName: string;
  subject: string;
}>;

export type DynamoDbCommandUnitOfWorkOptions = Readonly<{
  client: DynamoDbClientLike;
  tableName: string;
  idempotency?: DynamoDbCommandTransactionOptions["idempotency"];
}>;

const INVERTED_TIMESTAMP_MAX = 9_999_999_999_999;
const INVERTED_TIMESTAMP_WIDTH = 13;
const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

export class DynamoDbRepository implements LocalHttpReadableRepository {
  private readonly client: DynamoDbClientLike;
  private readonly tableName: string;
  private readonly consistentRead: boolean;
  private readonly idempotencyScope: DynamoDbIdempotencyScope | undefined;

  constructor(options: DynamoDbRepositoryOptions) {
    this.client = options.client;
    this.tableName = options.tableName;
    this.consistentRead = options.consistentRead ?? true;
    this.idempotencyScope = options.idempotencyScope;
  }

  async getState<TState = unknown>(
    resourceType: string,
    resourceId: string,
  ): Promise<ResourceState<TState> | undefined> {
    const output = await sendDynamoDb<GetItemCommandOutput>(
      this.client,
      new GetItemCommand({
        TableName: this.tableName,
        Key: marshallItem(resourceStateKey(resourceType, resourceId)),
        ConsistentRead: this.consistentRead,
      }),
    );

    return output.Item === undefined ? undefined : fromResourceStateItem<TState>(output.Item);
  }

  async listProjection(projectionName: string): Promise<ProjectionWrite[]> {
    const resourceType = resourceTypeFromProjectionName(projectionName);
    const output = await sendDynamoDb<QueryCommandOutput>(
      this.client,
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: marshallItem({
          ":pk": projectionPartitionKey(resourceType, projectionName),
        }),
        ConsistentRead: this.consistentRead,
      }),
    );

    return (output.Items ?? []).map((item) => {
      const projection = fromProjectionItem(item);

      return {
        projectionName: projection.projectionName,
        itemId: projection.itemId,
        sort: projection.sort,
        data: projection.data,
      };
    });
  }

  async getActivity(resourceType: string, resourceId: string): Promise<ActivityRecord[]> {
    const output = await sendDynamoDb<QueryCommandOutput>(
      this.client,
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: marshallItem({
          ":pk": resourceStateKey(resourceType, resourceId).PK,
          ":skPrefix": "ACT#",
        }),
        ConsistentRead: this.consistentRead,
        ScanIndexForward: true,
      }),
    );

    return (output.Items ?? []).map((item) => fromActivityItem(item));
  }

  async getIdempotency<TResponse = unknown>(
    key: string,
  ): Promise<IdempotencyRecord<TResponse> | undefined> {
    if (this.idempotencyScope === undefined) {
      throw new JawStackRuntimeError(
        "runtime.internal",
        "DynamoDB idempotency lookup requires a resource, command, and subject scope.",
      );
    }

    return this.getCommandIdempotency<TResponse>({
      ...this.idempotencyScope,
      idempotencyKey: key,
    });
  }

  async getCommandIdempotency<TResponse = unknown>(
    context: DynamoDbIdempotencyScope & Readonly<{ idempotencyKey: string }>,
  ): Promise<IdempotencyRecord<TResponse> | undefined> {
    const output = await sendDynamoDb<GetItemCommandOutput>(
      this.client,
      new GetItemCommand({
        TableName: this.tableName,
        Key: marshallItem(idempotencyKey(context)),
        ConsistentRead: this.consistentRead,
      }),
    );

    if (output.Item === undefined) {
      return undefined;
    }

    const record = fromIdempotencyItem<TResponse>(output.Item);

    return {
      key: record.idempotencyKey,
      fingerprint: record.payloadHash,
      response: record.response,
    };
  }
}

export class DynamoDbCommandUnitOfWork implements CommandUnitOfWork {
  private readonly client: DynamoDbClientLike;
  private readonly tableName: string;
  private readonly idempotency: DynamoDbCommandTransactionOptions["idempotency"];

  constructor(options: DynamoDbCommandUnitOfWorkOptions) {
    this.client = options.client;
    this.tableName = options.tableName;
    this.idempotency = options.idempotency;
  }

  async commit<TState = unknown, TResponse = unknown>(
    input: CommandCommitInput<TState, TResponse>,
  ): Promise<void> {
    try {
      await sendDynamoDb<TransactWriteItemsCommandOutput>(
        this.client,
        new TransactWriteItemsCommand({
          TransactItems: buildCommandTransactWriteItems(input, {
            tableName: this.tableName,
            ...(this.idempotency === undefined ? {} : { idempotency: this.idempotency }),
          }),
        }),
      );
    } catch (error) {
      throw mapDynamoDbCommitError(error, input);
    }
  }
}

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
  return {
    PK: projectionPartitionKey(input.resourceType, input.projectionName),
    SK: projectionSortKey(input.sort, input.itemId),
  };
}

export function projectionPartitionKey(resourceType: string, projectionName: string): string {
  const projectionNameSegment = projectionNameKeySegment(resourceType, projectionName);
  return `PROJ#${resourceType}#${projectionNameSegment}`;
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

async function sendDynamoDb<TOutput>(
  client: DynamoDbClientLike,
  command: DynamoDbCommand,
): Promise<TOutput> {
  return (await client.send(command)) as TOutput;
}

function resourceTypeFromProjectionName(projectionName: string): string {
  const separatorIndex = projectionName.indexOf(".");

  if (separatorIndex <= 0) {
    throw new JawStackRuntimeError(
      "runtime.internal",
      `Projection name "${projectionName}" must include a resource type prefix.`,
    );
  }

  return projectionName.slice(0, separatorIndex);
}

function mapDynamoDbCommitError<TState, TResponse>(
  error: unknown,
  input: CommandCommitInput<TState, TResponse>,
): JawStackRuntimeError {
  if (isDynamoDbConditionalFailure(error)) {
    const conditionalIndexes = conditionalFailureIndexes(error);
    const idempotencyIndex = input.idempotency === undefined ? -1 : transactionItemCount(input) - 1;

    if (idempotencyIndex >= 0 && conditionalIndexes.includes(idempotencyIndex)) {
      return new JawStackRuntimeError(
        "idempotency.conflict",
        "Idempotency key was already used for a different command payload.",
      );
    }

    return new JawStackRuntimeError(
      "resource.conflict",
      `Resource "${input.resource.resourceType}" with ID "${input.resource.resourceId}" changed before commit.`,
      {
        expectedVersion: input.resource.expectedVersion,
      },
    );
  }

  return new JawStackRuntimeError("runtime.unavailable", "DynamoDB command commit failed.", {
    causeName: errorName(error),
  });
}

function isDynamoDbConditionalFailure(error: unknown): boolean {
  if (errorName(error) === "ConditionalCheckFailedException") {
    return true;
  }

  return conditionalFailureIndexes(error).length > 0;
}

function conditionalFailureIndexes(error: unknown): number[] {
  const reasons = cancellationReasons(error);
  const indexes: number[] = [];

  reasons.forEach((reason, index) => {
    if (reason.Code === "ConditionalCheckFailed") {
      indexes.push(index);
    }
  });

  return indexes;
}

function cancellationReasons(error: unknown): ReadonlyArray<Readonly<{ Code?: string }>> {
  if (typeof error !== "object" || error === null || !("CancellationReasons" in error)) {
    return [];
  }

  const reasons = error.CancellationReasons;

  if (!Array.isArray(reasons)) {
    return [];
  }

  return reasons.filter((reason): reason is Readonly<{ Code?: string }> => {
    return typeof reason === "object" && reason !== null;
  });
}

function transactionItemCount<TState, TResponse>(
  input: CommandCommitInput<TState, TResponse>,
): number {
  return (
    1 +
    input.activity.length +
    input.outbox.length +
    input.projections.length +
    (input.idempotency === undefined ? 0 : 1)
  );
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return undefined;
  }

  return typeof error.name === "string" ? error.name : undefined;
}

function marshallItem(value: Record<string, unknown>): DynamoDbItem {
  return marshall(value, { removeUndefinedValues: true }) as DynamoDbItem;
}

function unmarshallItem<T>(item: DynamoDbItem): T {
  return unmarshall(item) as T;
}
