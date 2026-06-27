import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type PutItemCommandOutput,
  type QueryCommandOutput,
  type TransactWriteItem,
  type TransactWriteItemsCommandOutput,
  type UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { PutEventsCommand, type PutEventsCommandOutput } from "@aws-sdk/client-eventbridge";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type {
  ActivityRecord,
  ApiSuccess,
  AuthContext,
  AuthProvider,
  CommandCommitInput,
  CommandUnitOfWork,
  CostProfile,
  IdempotencyCommit,
  IdempotencyRecord,
  JawStackEvent,
  LocalHttpRequestContext,
  LocalHttpReadableRepository,
  ManifestAuth,
  ProjectionRecord,
  ProjectionWrite,
  ResourceDefinition,
  ResourceRegistry,
  ResourceState,
  RuntimeErrorCode,
  IdGenerator,
} from "@jawstack/core";
import { createManifest, executeCommand, JawStackRuntimeError } from "@jawstack/core";

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

export type AwsSdkCommand = DynamoDbCommand;

export type AwsSdkClientLike = Readonly<{
  send(command: AwsSdkCommand): Promise<unknown>;
}>;

export type EventBridgeClientLike = AwsSdkClientLike;

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

export type EventBridgePublisherOptions = Readonly<{
  client: EventBridgeClientLike;
  eventBusName: string;
  source?: string;
}>;

export type OutboxDispatchResult = Readonly<{
  seen: number;
  ignored: number;
  published: number;
  markedPublished: number;
}>;

export type DynamoDbStreamRecord = Readonly<{
  eventName?: string;
  dynamodb?: Readonly<{
    NewImage?: DynamoDbItem;
    OldImage?: DynamoDbItem;
  }>;
}>;

export type DynamoDbStreamEvent = Readonly<{
  Records?: readonly DynamoDbStreamRecord[];
}>;

export type DynamoDbOutboxDispatcherOptions = Readonly<{
  dynamoDbClient: DynamoDbClientLike;
  tableName: string;
  publisher: EventBridgePublisher;
  clock?: () => Date;
}>;

export type DynamoDbOutboxSweeperOptions = Readonly<{
  dynamoDbClient: DynamoDbClientLike;
  tableName: string;
  publisher: EventBridgePublisher;
  clock?: () => Date;
  staleAfterMs?: number;
  batchLimit?: number;
}>;

export type WorkerMessage<TEvent = unknown> = Readonly<{
  event: JawStackEvent<TEvent>;
  messageId: string;
  receivedAt: string;
}>;

export type WorkerHandler<TEvent = unknown> = (
  message: WorkerMessage<TEvent>,
) => Promise<void> | void;

export type SqsRecord = Readonly<{
  messageId: string;
  body: string;
}>;

export type SqsEvent = Readonly<{
  Records?: readonly SqsRecord[];
}>;

export type SqsWorkerResult = Readonly<{
  seen: number;
  processed: number;
  skipped: number;
}>;

export type DynamoDbWorkerIdempotencyStoreOptions = Readonly<{
  client: DynamoDbClientLike;
  tableName: string;
  clock?: () => Date;
  ttlSeconds?: number;
}>;

export type SqsWorkerAdapterOptions<TEvent = unknown> = Readonly<{
  workerName: string;
  handler: WorkerHandler<TEvent>;
  idempotencyStore: DynamoDbWorkerIdempotencyStore;
  clock?: () => Date;
}>;

export type SchedulerEvent = Readonly<{
  id?: string;
  time?: string;
  source?: string;
  detail?: unknown;
  targetHandler?: string;
  scheduleName?: string;
  [key: string]: unknown;
}>;

export type SchedulerHandler<TResult = unknown> = (
  event: SchedulerEvent,
) => Promise<TResult> | TResult;

export type SchedulerTargetAdapterOptions = Readonly<{
  handlers: Readonly<Record<string, SchedulerHandler>>;
  defaultHandler?: string;
}>;

export type SchedulerTargetAdapterResult = Readonly<{
  targetHandler: string;
  result: unknown;
}>;

export type StaleWorkRequestReminder = Readonly<{
  resourceId: string;
  title: string;
  updatedAt: string;
  assigneeId?: string;
  status: "open";
}>;

export type StaleWorkRequestReminderResult = Readonly<{
  scanned: number;
  stale: number;
  reminders: readonly StaleWorkRequestReminder[];
}>;

export type StaleWorkRequestReminderOptions = Readonly<{
  repository: Pick<LocalHttpReadableRepository, "listProjection">;
  staleAfterMs?: number;
  clock?: () => Date;
  onReminder?: (reminder: StaleWorkRequestReminder, event: SchedulerEvent) => Promise<void> | void;
}>;

export type LambdaHttpEvent = Readonly<{
  version?: string;
  rawPath?: string;
  rawQueryString?: string;
  path?: string;
  httpMethod?: string;
  headers?: Record<string, string | undefined> | undefined;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext?: Readonly<{
    requestId?: string;
    http?: Readonly<{
      method?: string;
      path?: string;
    }>;
  }>;
}>;

export type LambdaHttpResponse = Readonly<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: false;
}>;

export type LambdaHttpRequestContext = LocalHttpRequestContext &
  Readonly<{
    event: LambdaHttpEvent;
  }>;

export type LambdaRepositoryFactoryInput = Readonly<{
  context: LambdaHttpRequestContext;
  auth?: AuthContext;
  idempotencyScope?: DynamoDbIdempotencyScope;
}>;

export type LambdaHttpAdapterOptions = Readonly<{
  appName: string;
  stage: string;
  registry: ResourceRegistry | readonly ResourceDefinition[];
  repository: LocalHttpReadableRepository;
  unitOfWork: CommandUnitOfWork;
  authProvider: AuthProvider;
  repositoryFactory?: (input: LambdaRepositoryFactoryInput) => LocalHttpReadableRepository;
  auth?: ManifestAuth;
  costProfile?: CostProfile;
  ids?: Partial<IdGenerator>;
  clock?: () => Date;
  source?: string;
}>;

const INVERTED_TIMESTAMP_MAX = 9_999_999_999_999;
const INVERTED_TIMESTAMP_WIDTH = 13;
const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_WORKER_IDEMPOTENCY_TTL_SECONDS = 14 * 24 * 60 * 60;
const DEFAULT_OUTBOX_SWEEP_BATCH_LIMIT = 10;
const DEFAULT_OUTBOX_STALE_AFTER_MS = 2 * 60 * 1000;
const DEFAULT_WORK_REQUEST_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

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

export class EventBridgePublisher {
  private readonly client: EventBridgeClientLike;
  private readonly eventBusName: string;
  private readonly source: string | undefined;

  constructor(options: EventBridgePublisherOptions) {
    this.client = options.client;
    this.eventBusName = options.eventBusName;
    this.source = options.source;
  }

  async publish<TPayload = unknown>(event: JawStackEvent<TPayload>): Promise<void> {
    try {
      const output = await sendDynamoDb<PutEventsCommandOutput>(
        this.client,
        new PutEventsCommand({
          Entries: [
            {
              Source: this.source ?? event.source,
              DetailType: event.eventType,
              Detail: JSON.stringify(event),
              EventBusName: this.eventBusName,
            },
          ],
        }),
      );

      const failedEntry = output.Entries?.find((entry) => entry.ErrorCode !== undefined);

      if ((output.FailedEntryCount ?? 0) > 0 || failedEntry !== undefined) {
        throw new JawStackRuntimeError("runtime.unavailable", "EventBridge publish failed.", {
          errorCode: failedEntry?.ErrorCode,
          errorMessage: failedEntry?.ErrorMessage,
          failedEntryCount: output.FailedEntryCount ?? 0,
        });
      }
    } catch (error) {
      if (error instanceof JawStackRuntimeError) {
        throw error;
      }

      throw new JawStackRuntimeError("runtime.unavailable", "EventBridge publish failed.", {
        causeName: errorName(error),
      });
    }
  }
}

export class DynamoDbOutboxDispatcher {
  private readonly dynamoDbClient: DynamoDbClientLike;
  private readonly tableName: string;
  private readonly publisher: EventBridgePublisher;
  private readonly clock: () => Date;

  constructor(options: DynamoDbOutboxDispatcherOptions) {
    this.dynamoDbClient = options.dynamoDbClient;
    this.tableName = options.tableName;
    this.publisher = options.publisher;
    this.clock = options.clock ?? (() => new Date());
  }

  async dispatchStream(event: DynamoDbStreamEvent): Promise<OutboxDispatchResult> {
    return this.dispatchRecords(event.Records ?? []);
  }

  async dispatchRecords(records: readonly DynamoDbStreamRecord[]): Promise<OutboxDispatchResult> {
    let ignored = 0;
    let published = 0;
    let markedPublished = 0;

    for (const record of records) {
      const item = pendingOutboxItemFromStreamRecord(record);

      if (item === undefined) {
        ignored += 1;
        continue;
      }

      const result = await publishAndMarkOutboxItem({
        item,
        publisher: this.publisher,
        dynamoDbClient: this.dynamoDbClient,
        tableName: this.tableName,
        publishedAt: this.clock().toISOString(),
      });

      published += result.published;
      markedPublished += result.markedPublished;
    }

    return {
      seen: records.length,
      ignored,
      published,
      markedPublished,
    };
  }
}

export class DynamoDbOutboxSweeper {
  private readonly dynamoDbClient: DynamoDbClientLike;
  private readonly tableName: string;
  private readonly publisher: EventBridgePublisher;
  private readonly clock: () => Date;
  private readonly staleAfterMs: number;
  private readonly batchLimit: number;

  constructor(options: DynamoDbOutboxSweeperOptions) {
    this.dynamoDbClient = options.dynamoDbClient;
    this.tableName = options.tableName;
    this.publisher = options.publisher;
    this.clock = options.clock ?? (() => new Date());
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_OUTBOX_STALE_AFTER_MS;
    this.batchLimit = options.batchLimit ?? DEFAULT_OUTBOX_SWEEP_BATCH_LIMIT;
  }

  async sweep(): Promise<OutboxDispatchResult> {
    const now = this.clock();
    const staleBefore = new Date(now.getTime() - this.staleAfterMs).toISOString();
    const output = await sendDynamoDb<QueryCommandOutput>(
      this.dynamoDbClient,
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :status AND GSI1SK < :staleBefore",
        ExpressionAttributeValues: marshallItem({
          ":status": "OUTBOX#PENDING",
          ":staleBefore": `${staleBefore}#~`,
        }),
        ScanIndexForward: true,
        Limit: this.batchLimit,
      }),
    );

    const items = (output.Items ?? [])
      .map((item) => safeOutboxItem(item))
      .filter((item): item is DynamoDbOutboxEventItem => item?.status === "PENDING");

    let published = 0;
    let markedPublished = 0;

    for (const item of items) {
      const result = await publishAndMarkOutboxItem({
        item,
        publisher: this.publisher,
        dynamoDbClient: this.dynamoDbClient,
        tableName: this.tableName,
        publishedAt: now.toISOString(),
      });

      published += result.published;
      markedPublished += result.markedPublished;
    }

    return {
      seen: output.Items?.length ?? 0,
      ignored: (output.Items?.length ?? 0) - items.length,
      published,
      markedPublished,
    };
  }
}

export class DynamoDbWorkerIdempotencyStore {
  private readonly client: DynamoDbClientLike;
  private readonly tableName: string;
  private readonly clock: () => Date;
  private readonly ttlSeconds: number;

  constructor(options: DynamoDbWorkerIdempotencyStoreOptions) {
    this.client = options.client;
    this.tableName = options.tableName;
    this.clock = options.clock ?? (() => new Date());
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_WORKER_IDEMPOTENCY_TTL_SECONDS;
  }

  async hasProcessed(workerName: string, eventId: string): Promise<boolean> {
    const output = await sendDynamoDb<GetItemCommandOutput>(
      this.client,
      new GetItemCommand({
        TableName: this.tableName,
        Key: marshallItem(workerIdempotencyKey(workerName, eventId)),
        ConsistentRead: true,
      }),
    );

    return output.Item !== undefined;
  }

  async markProcessed(workerName: string, eventId: string): Promise<boolean> {
    const processedAt = this.clock().toISOString();
    const expiresAt = Math.floor(Date.parse(processedAt) / 1000) + this.ttlSeconds;

    try {
      await sendDynamoDb<PutItemCommandOutput>(
        this.client,
        new PutItemCommand({
          TableName: this.tableName,
          Item: toWorkerIdempotencyItem({
            workerName,
            eventId,
            processedAt,
            expiresAt,
          }),
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );

      return true;
    } catch (error) {
      if (isDynamoDbConditionalFailure(error)) {
        return false;
      }

      throw new JawStackRuntimeError(
        "runtime.unavailable",
        "DynamoDB worker marker write failed.",
        {
          causeName: errorName(error),
        },
      );
    }
  }
}

export class SqsWorkerAdapter<TEvent = unknown> {
  private readonly workerName: string;
  private readonly handler: WorkerHandler<TEvent>;
  private readonly idempotencyStore: DynamoDbWorkerIdempotencyStore;
  private readonly clock: () => Date;

  constructor(options: SqsWorkerAdapterOptions<TEvent>) {
    this.workerName = options.workerName;
    this.handler = options.handler;
    this.idempotencyStore = options.idempotencyStore;
    this.clock = options.clock ?? (() => new Date());
  }

  async handle(event: SqsEvent): Promise<SqsWorkerResult> {
    let processed = 0;
    let skipped = 0;
    const records = event.Records ?? [];

    for (const record of records) {
      const jawStackEvent = parseSqsWorkerEvent<TEvent>(record.body);

      if (await this.idempotencyStore.hasProcessed(this.workerName, jawStackEvent.eventId)) {
        skipped += 1;
        continue;
      }

      await this.handler({
        event: jawStackEvent,
        messageId: record.messageId,
        receivedAt: this.clock().toISOString(),
      });

      const marked = await this.idempotencyStore.markProcessed(
        this.workerName,
        jawStackEvent.eventId,
      );

      if (marked) {
        processed += 1;
      } else {
        skipped += 1;
      }
    }

    return {
      seen: records.length,
      processed,
      skipped,
    };
  }
}

export function createSchedulerTargetAdapter(
  options: SchedulerTargetAdapterOptions,
): SchedulerHandler<SchedulerTargetAdapterResult> {
  return async (event) => {
    const targetHandler = schedulerTargetHandlerName(event) ?? options.defaultHandler;

    if (targetHandler === undefined) {
      throw new JawStackRuntimeError(
        "runtime.internal",
        "Scheduler event did not include a target handler.",
      );
    }

    const handler = options.handlers[targetHandler];

    if (handler === undefined) {
      throw new JawStackRuntimeError(
        "runtime.internal",
        `No scheduler handler is registered for "${targetHandler}".`,
      );
    }

    return {
      targetHandler,
      result: await handler(event),
    };
  };
}

export function createStaleWorkRequestReminderHandler(
  options: StaleWorkRequestReminderOptions,
): SchedulerHandler<StaleWorkRequestReminderResult> {
  return async (event) => {
    const listProjection = options.repository.listProjection;

    if (listProjection === undefined) {
      throw new JawStackRuntimeError(
        "runtime.internal",
        "Stale Work Request reminders require repository.listProjection.",
      );
    }

    const now = options.clock?.() ?? new Date();
    const staleBefore =
      now.getTime() - (options.staleAfterMs ?? DEFAULT_WORK_REQUEST_STALE_AFTER_MS);
    const items = await listProjection.call(options.repository, "workRequest.list");
    const reminders = items
      .map((item) => staleOpenWorkRequestReminder(item, staleBefore))
      .filter((item): item is StaleWorkRequestReminder => item !== undefined);

    for (const reminder of reminders) {
      await options.onReminder?.(reminder, event);
    }

    return {
      scanned: items.length,
      stale: reminders.length,
      reminders,
    };
  };
}

export function createApiGatewayLambdaHandler(
  options: LambdaHttpAdapterOptions,
): (event: LambdaHttpEvent) => Promise<LambdaHttpResponse> {
  return async (event) => {
    const context = createLambdaHttpRequestContext(event);
    const requestId =
      headerValue(context.headers, "x-jawstack-request-id") ?? lambdaRequestId(event);
    const correlationId = headerValue(context.headers, "x-jawstack-correlation-id") ?? requestId;

    try {
      const result = await handleLambdaHttpRequest(context, options, requestId, correlationId);
      return lambdaJsonResponse(result.statusCode, result.body);
    } catch (error) {
      const apiErrorResponse =
        error instanceof JawStackRuntimeError
          ? apiError(error.code, error.message, requestId, correlationId, error.details)
          : apiError(
              "runtime.internal",
              "An internal runtime error occurred.",
              requestId,
              correlationId,
            );

      return lambdaJsonResponse(httpStatusForError(apiErrorResponse.error.code), apiErrorResponse);
    }
  };
}

export const createLambdaHttpHandler = createApiGatewayLambdaHandler;

async function handleLambdaHttpRequest(
  context: LambdaHttpRequestContext,
  options: LambdaHttpAdapterOptions,
  requestId: string,
  correlationId: string,
): Promise<Readonly<{ statusCode: number; body: unknown }>> {
  const segments = pathSegments(context.url);

  if (
    context.method === "GET" &&
    segments.length === 2 &&
    segments[0] === "api" &&
    segments[1] === "health"
  ) {
    return {
      statusCode: 200,
      body: apiSuccess({ status: "ok" }, requestId, correlationId),
    };
  }

  if (
    context.method === "GET" &&
    segments.length === 2 &&
    segments[0] === "api" &&
    segments[1] === "manifest"
  ) {
    const manifest = createManifest({
      appName: options.appName,
      stage: options.stage,
      stable: true,
      resources: options.registry,
      auth: options.auth ?? { mode: "dev", provider: "lambda" },
      costProfile: options.costProfile ?? {},
    });

    return {
      statusCode: 200,
      body: apiSuccess(manifest, requestId, correlationId),
    };
  }

  if (segments[0] !== "api" || segments[1] !== "resources") {
    return {
      statusCode: 404,
      body: apiError("resource.not_found", "Route not found.", requestId, correlationId),
    };
  }

  const auth = await options.authProvider.resolve(context);
  const resourceType = segments[2];

  if (resourceType === undefined) {
    return {
      statusCode: 404,
      body: apiError(
        "resource.not_found",
        "Resource type route not found.",
        requestId,
        correlationId,
      ),
    };
  }

  if (context.method === "GET" && segments.length === 3) {
    const projectionName = `${resourceType}.list`;
    const repository = repositoryForRequest(options, { context, auth });
    const items = await repository.listProjection?.(projectionName);

    return {
      statusCode: 200,
      body: apiSuccess({ items: items ?? [] }, requestId, correlationId),
    };
  }

  if (context.method === "GET" && segments.length === 4) {
    const resourceId = segments[3] ?? "";
    const repository = repositoryForRequest(options, { context, auth });
    const state = await repository.getState(resourceType, resourceId);

    if (state === undefined) {
      const error = apiError(
        "resource.not_found",
        `Resource "${resourceType}" with ID "${resourceId}" was not found.`,
        requestId,
        correlationId,
      );
      return { statusCode: 404, body: error };
    }

    return {
      statusCode: 200,
      body: apiSuccess(state, requestId, correlationId),
    };
  }

  if (context.method === "GET" && segments.length === 5 && segments[4] === "activity") {
    const resourceId = segments[3] ?? "";
    const repository = repositoryForRequest(options, { context, auth });
    const state = await repository.getState(resourceType, resourceId);

    if (state === undefined) {
      const error = apiError(
        "resource.not_found",
        `Resource "${resourceType}" with ID "${resourceId}" was not found.`,
        requestId,
        correlationId,
      );
      return { statusCode: 404, body: error };
    }

    const activity = await repository.getActivity?.(resourceType, resourceId);
    return {
      statusCode: 200,
      body: apiSuccess({ items: activity ?? [] }, requestId, correlationId),
    };
  }

  if (context.method === "POST" && segments.length === 5 && segments[3] === "commands") {
    return executeLambdaCommand(
      {
        context,
        options,
        requestId,
        correlationId,
        auth,
        resourceType,
        commandName: segments[4] ?? "",
      },
      await readLambdaJsonBody(context.event),
    );
  }

  if (context.method === "POST" && segments.length === 6 && segments[4] === "commands") {
    return executeLambdaCommand(
      {
        context,
        options,
        requestId,
        correlationId,
        auth,
        resourceType,
        resourceId: segments[3] ?? "",
        commandName: segments[5] ?? "",
      },
      await readLambdaJsonBody(context.event),
    );
  }

  return {
    statusCode: 404,
    body: apiError("resource.not_found", "Route not found.", requestId, correlationId),
  };
}

async function executeLambdaCommand(
  input: Readonly<{
    context: LambdaHttpRequestContext;
    options: LambdaHttpAdapterOptions;
    requestId: string;
    correlationId: string;
    auth: AuthContext;
    resourceType: string;
    resourceId?: string;
    commandName: string;
  }>,
  bodyValue: unknown,
): Promise<Readonly<{ statusCode: number; body: unknown }>> {
  const body = commandRequestBody(bodyValue);
  const repository = repositoryForRequest(input.options, {
    context: input.context,
    auth: input.auth,
    idempotencyScope: {
      resourceType: input.resourceType,
      commandName: input.commandName,
      subject: input.auth.subject,
    },
  });
  const result = await executeCommand(
    {
      requestId: input.requestId,
      correlationId: input.correlationId,
      resourceType: input.resourceType,
      ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
      commandName: input.commandName,
      input: body.input,
      ...(body.idempotencyKey === undefined ? {} : { idempotencyKey: body.idempotencyKey }),
      requestContext: input.context,
    },
    {
      registry: input.options.registry,
      repository,
      unitOfWork: input.options.unitOfWork,
      authProvider: new StaticAuthProvider(input.auth),
      ...(input.options.ids === undefined ? {} : { ids: input.options.ids }),
      ...(input.options.clock === undefined ? {} : { clock: input.options.clock }),
      ...(input.options.source === undefined ? {} : { source: input.options.source }),
    },
  );

  return {
    statusCode: result.ok ? 200 : httpStatusForError(result.error.code),
    body: result,
  };
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

export function pendingOutboxItemFromStreamRecord(
  record: DynamoDbStreamRecord,
): DynamoDbOutboxEventItem | undefined {
  const item =
    record.dynamodb?.NewImage === undefined ? undefined : safeOutboxItem(record.dynamodb.NewImage);

  if (item === undefined || item.status !== "PENDING") {
    return undefined;
  }

  if (record.eventName === "INSERT") {
    return item;
  }

  if (record.eventName === "MODIFY") {
    const previous =
      record.dynamodb?.OldImage === undefined
        ? undefined
        : safeOutboxItem(record.dynamodb.OldImage);
    return previous?.status === "PENDING" ? undefined : item;
  }

  return undefined;
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

function parseSqsWorkerEvent<TEvent = unknown>(body: string): JawStackEvent<TEvent> {
  const parsed = parseJsonRecord(body);
  const eventCandidate = eventBridgeDetail(parsed);

  if (!isJawStackEvent(eventCandidate)) {
    throw new JawStackRuntimeError(
      "runtime.internal",
      "SQS worker message did not contain a JawStack event.",
    );
  }

  return eventCandidate as JawStackEvent<TEvent>;
}

function parseJsonRecord(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new JawStackRuntimeError(
      "runtime.internal",
      "SQS worker message body must be valid JSON.",
    );
  }
}

function eventBridgeDetail(value: unknown): unknown {
  if (!isRecord(value) || !("detail" in value)) {
    return value;
  }

  const detail = value.detail;

  if (typeof detail === "string") {
    return parseJsonRecord(detail);
  }

  return detail;
}

function isJawStackEvent(value: unknown): value is JawStackEvent {
  return (
    isRecord(value) &&
    value.envelopeVersion === 1 &&
    typeof value.eventId === "string" &&
    typeof value.eventType === "string" &&
    typeof value.resourceType === "string" &&
    typeof value.resourceId === "string"
  );
}

function schedulerTargetHandlerName(event: SchedulerEvent): string | undefined {
  if (typeof event.targetHandler === "string" && event.targetHandler.trim().length > 0) {
    return event.targetHandler;
  }

  if (!isRecord(event.detail)) {
    return undefined;
  }

  return typeof event.detail.targetHandler === "string" &&
    event.detail.targetHandler.trim().length > 0
    ? event.detail.targetHandler
    : undefined;
}

function staleOpenWorkRequestReminder(
  item: ProjectionRecord,
  staleBefore: number,
): StaleWorkRequestReminder | undefined {
  if (item.data.status !== "open" || typeof item.data.updatedAt !== "string") {
    return undefined;
  }

  const updatedAtMillis = Date.parse(item.data.updatedAt);

  if (!Number.isFinite(updatedAtMillis) || updatedAtMillis >= staleBefore) {
    return undefined;
  }

  return {
    resourceId: item.itemId,
    title: typeof item.data.title === "string" ? item.data.title : item.itemId,
    updatedAt: item.data.updatedAt,
    ...(typeof item.data.assigneeId === "string" ? { assigneeId: item.data.assigneeId } : {}),
    status: "open",
  };
}

class StaticAuthProvider implements AuthProvider {
  constructor(private readonly auth: AuthContext) {}

  resolve(): AuthContext {
    return this.auth;
  }
}

function createLambdaHttpRequestContext(event: LambdaHttpEvent): LambdaHttpRequestContext {
  const method = lambdaHttpMethod(event);
  const url = lambdaUrl(event);

  return {
    method,
    url,
    headers: normalizeHeaders(event.headers ?? {}),
    event,
  };
}

function lambdaHttpMethod(event: LambdaHttpEvent): string {
  return (event.requestContext?.http?.method ?? event.httpMethod ?? "GET").toUpperCase();
}

function lambdaUrl(event: LambdaHttpEvent): string {
  const path = event.rawPath ?? event.path ?? event.requestContext?.http?.path ?? "/";
  const queryString = event.rawQueryString;
  return queryString === undefined || queryString.length === 0 ? path : `${path}?${queryString}`;
}

function lambdaRequestId(event: LambdaHttpEvent): string {
  return event.requestContext?.requestId ?? `req_${crypto.randomUUID()}`;
}

function normalizeHeaders(
  headers: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function headerValue(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];

  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : undefined;
  }

  return typeof value === "string" ? value : undefined;
}

function pathSegments(url: string): string[] {
  const parsed = new URL(url, "https://lambda.local");
  return parsed.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(decodeURIComponent);
}

async function readLambdaJsonBody(event: LambdaHttpEvent): Promise<unknown> {
  const rawBody = event.body;

  if (rawBody === undefined || rawBody === null || rawBody.trim().length === 0) {
    return {};
  }

  const decoded =
    event.isBase64Encoded === true ? Buffer.from(rawBody, "base64").toString("utf8") : rawBody;

  if (decoded.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(decoded);
  } catch {
    throw new JawStackRuntimeError("command.validation", "Request body must be valid JSON.");
  }
}

function commandRequestBody(value: unknown): Readonly<{
  input: unknown;
  idempotencyKey?: string;
}> {
  if (!isRecord(value)) {
    throw new JawStackRuntimeError("command.validation", "Command request body must be an object.");
  }

  const idempotencyKey = value.idempotencyKey;

  if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
    throw new JawStackRuntimeError(
      "command.validation",
      "Command idempotencyKey must be a string when provided.",
    );
  }

  return {
    input: value.input ?? {},
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

function repositoryForRequest(
  options: LambdaHttpAdapterOptions,
  input: LambdaRepositoryFactoryInput,
): LocalHttpReadableRepository {
  return options.repositoryFactory?.(input) ?? options.repository;
}

function lambdaJsonResponse(statusCode: number, body: unknown): LambdaHttpResponse {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: `${JSON.stringify(body)}\n`,
    isBase64Encoded: false,
  };
}

function apiSuccess<T>(data: T, requestId: string, correlationId: string): ApiSuccess<T> {
  return {
    ok: true,
    data,
    meta: {
      requestId,
      correlationId,
    },
  };
}

function apiError(
  code: RuntimeErrorCode,
  message: string,
  requestId: string,
  correlationId: string,
  details?: unknown,
): Readonly<{
  ok: false;
  error: Readonly<{
    code: RuntimeErrorCode;
    message: string;
    details?: unknown;
  }>;
  meta: Readonly<{
    requestId: string;
    correlationId: string;
  }>;
}> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
    meta: {
      requestId,
      correlationId,
    },
  };
}

function httpStatusForError(code: RuntimeErrorCode): number {
  switch (code) {
    case "command.validation":
      return 400;
    case "auth.missing":
      return 401;
    case "auth.forbidden":
      return 403;
    case "resource.not_found":
      return 404;
    case "resource.conflict":
    case "idempotency.conflict":
      return 409;
    case "command.rejected":
    case "resource.invalid_state":
      return 422;
    case "runtime.unavailable":
      return 503;
    case "runtime.internal":
      return 500;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function publishAndMarkOutboxItem<TPayload = unknown>(
  input: Readonly<{
    item: DynamoDbOutboxEventItem<TPayload>;
    publisher: EventBridgePublisher;
    dynamoDbClient: DynamoDbClientLike;
    tableName: string;
    publishedAt: string;
  }>,
): Promise<Readonly<{ published: number; markedPublished: number }>> {
  await input.publisher.publish(input.item.event);
  const markedPublished = await markOutboxEventPublished({
    item: input.item,
    dynamoDbClient: input.dynamoDbClient,
    tableName: input.tableName,
    publishedAt: input.publishedAt,
  });

  return {
    published: 1,
    markedPublished: markedPublished ? 1 : 0,
  };
}

async function markOutboxEventPublished<TPayload = unknown>(
  input: Readonly<{
    item: DynamoDbOutboxEventItem<TPayload>;
    dynamoDbClient: DynamoDbClientLike;
    tableName: string;
    publishedAt: string;
  }>,
): Promise<boolean> {
  try {
    await sendDynamoDb<UpdateItemCommandOutput>(
      input.dynamoDbClient,
      new UpdateItemCommand({
        TableName: input.tableName,
        Key: marshallItem(outboxEventKey(input.item.eventId)),
        UpdateExpression:
          "SET #status = :published, publishedAt = :publishedAt, updatedAt = :publishedAt, attempts = if_not_exists(attempts, :zero) + :one, GSI1PK = :gsi1pk, GSI1SK = :gsi1sk REMOVE lastError",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: marshallItem({
          ":published": "PUBLISHED",
          ":pending": "PENDING",
          ":publishedAt": input.publishedAt,
          ":zero": 0,
          ":one": 1,
          ":gsi1pk": "OUTBOX#PUBLISHED",
          ":gsi1sk": `${input.publishedAt}#${input.item.eventId}`,
        }),
      }),
    );

    return true;
  } catch (error) {
    if (isDynamoDbConditionalFailure(error)) {
      return false;
    }

    throw new JawStackRuntimeError("runtime.unavailable", "DynamoDB outbox update failed.", {
      causeName: errorName(error),
    });
  }
}

function safeOutboxItem(item: DynamoDbItem): DynamoDbOutboxEventItem | undefined {
  try {
    const outboxItem = fromOutboxEventItem(item);
    return outboxItem.itemKind === "OUTBOX_EVENT" ? outboxItem : undefined;
  } catch {
    return undefined;
  }
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
