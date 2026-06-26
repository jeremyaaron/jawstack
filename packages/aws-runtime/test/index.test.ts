import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  createInMemoryPersistence,
  HeaderAuthProvider,
  TestAuthProvider,
  workRequestResource,
  type AuthContext,
  type ActivityRecord,
  type ApiSuccess,
  type CommandCommitInput,
  type JawStackEvent,
  type ProjectionWrite,
  type ResourceState,
} from "@jawstack/core";
import { describe, expect, it } from "vitest";

import {
  activityKey,
  buildCommandTransactWriteItems,
  buildProjectionTransactWriteItem,
  buildResourceStateTransactWriteItem,
  createApiGatewayLambdaHandler,
  createLambdaHttpHandler,
  describePackage,
  DynamoDbCommandUnitOfWork,
  DynamoDbOutboxDispatcher,
  DynamoDbOutboxSweeper,
  DynamoDbRepository,
  DynamoDbWorkerIdempotencyStore,
  EventBridgePublisher,
  fromActivityItem,
  fromIdempotencyItem,
  fromOutboxEventItem,
  fromProjectionItem,
  fromResourceStateItem,
  fromWorkerIdempotencyItem,
  idempotencyContextFromCoreRecord,
  idempotencyKey,
  invertedTimestamp,
  outboxEventKey,
  outboxStatusKey,
  packageName,
  pendingOutboxItemFromStreamRecord,
  projectionPartitionKey,
  projectionKey,
  resourceStateKey,
  toActivityItem,
  toIdempotencyItem,
  toOutboxEventItem,
  toProjectionItem,
  toResourceStateItem,
  toWorkerIdempotencyItem,
  SqsWorkerAdapter,
  workerIdempotencyKey,
  type LambdaHttpAdapterOptions,
  type LambdaHttpEvent,
  type LambdaHttpResponse,
  type LambdaRepositoryFactoryInput,
} from "../src/index";

describe("@jawstack/aws-runtime", () => {
  it("exports package metadata", () => {
    expect(packageName).toBe("@jawstack/aws-runtime");
    expect(describePackage()).toContain("DynamoDB");
  });

  it("builds documented DynamoDB keys", () => {
    expect(resourceStateKey("workRequest", "wr_123")).toEqual({
      PK: "RES#workRequest#wr_123",
      SK: "STATE",
    });

    expect(
      activityKey({
        resourceType: "workRequest",
        resourceId: "wr_123",
        occurredAt: "2026-06-25T12:00:00.000Z",
        activityId: "act_123",
      }),
    ).toEqual({
      PK: "RES#workRequest#wr_123",
      SK: "ACT#2026-06-25T12:00:00.000Z#act_123",
    });

    expect(outboxEventKey("evt_123")).toEqual({
      PK: "OUTBOX#evt_123",
      SK: "EVENT",
    });

    expect(outboxStatusKey("PENDING", "2026-06-25T12:00:00.000Z", "evt_123")).toEqual({
      GSI1PK: "OUTBOX#PENDING",
      GSI1SK: "2026-06-25T12:00:00.000Z#evt_123",
    });

    expect(
      idempotencyKey({
        resourceType: "workRequest",
        commandName: "assign",
        subject: "user_123",
        idempotencyKey: "idem_123",
      }),
    ).toEqual({
      PK: "IDEMP#workRequest#assign#user_123",
      SK: "idem_123",
    });

    expect(
      projectionKey({
        resourceType: "workRequest",
        projectionName: "workRequest.list",
        itemId: "wr_123",
        sort: "8258804799999",
      }),
    ).toEqual({
      PK: "PROJ#workRequest#list",
      SK: "8258804799999#wr_123",
    });
    expect(projectionPartitionKey("workRequest", "workRequest.list")).toBe("PROJ#workRequest#list");

    expect(workerIdempotencyKey("staleWorkRequestReminder", "evt_123")).toEqual({
      PK: "WORKER#staleWorkRequestReminder#PROCESSED",
      SK: "evt_123",
    });
  });

  it("keeps projection sort keys stable when the sort already includes the item id", () => {
    expect(
      projectionKey({
        resourceType: "workRequest",
        projectionName: "workRequest.list",
        itemId: "wr_123",
        sort: "9007197490050991#wr_123",
      }),
    ).toEqual({
      PK: "PROJ#workRequest#list",
      SK: "9007197490050991#wr_123",
    });
  });

  it("creates deterministic inverted timestamp sort segments", () => {
    expect(invertedTimestamp("2026-06-25T12:00:00.000Z")).toBe("8217611199999");
  });

  it("round-trips resource state items", () => {
    const state = resourceState();
    const item = toResourceStateItem(state);

    expect(unmarshall(item)).toMatchObject({
      PK: "RES#workRequest#wr_123",
      SK: "STATE",
      itemKind: "RESOURCE_STATE",
      resourceType: "workRequest",
      resourceId: "wr_123",
      tenantId: "tenant_123",
    });
    expect(fromResourceStateItem(item)).toEqual(state);
  });

  it("round-trips activity items", () => {
    const activity = activityRecord();
    const item = toActivityItem(activity);

    expect(unmarshall(item)).toMatchObject({
      PK: "RES#workRequest#wr_123",
      SK: "ACT#2026-06-25T12:00:00.000Z#act_123",
      itemKind: "ACTIVITY",
      title: "Assigned work request",
    });
    expect(fromActivityItem(item)).toEqual(activity);
  });

  it("round-trips outbox event items", () => {
    const event = jawStackEvent();
    const item = toOutboxEventItem(event);

    expect(unmarshall(item)).toMatchObject({
      PK: "OUTBOX#evt_123",
      SK: "EVENT",
      GSI1PK: "OUTBOX#PENDING",
      GSI1SK: "2026-06-25T12:00:00.000Z#evt_123",
      itemKind: "OUTBOX_EVENT",
      eventId: "evt_123",
      attempts: 0,
    });
    expect(fromOutboxEventItem(item)).toMatchObject({
      event,
      status: "PENDING",
      createdAt: "2026-06-25T12:00:00.000Z",
      updatedAt: "2026-06-25T12:00:00.000Z",
    });
  });

  it("round-trips idempotency items", () => {
    const success = apiSuccess();
    const context = idempotencyContextFromCoreRecord(
      {
        key: "idem_123",
        fingerprint: "payload_hash_123",
        response: success,
      },
      {
        resourceType: "workRequest",
        commandName: "assign",
        subject: "user_123",
        resourceId: "wr_123",
        createdAt: "2026-06-25T12:00:00.000Z",
      },
    );
    const item = toIdempotencyItem(context, success);

    expect(unmarshall(item)).toMatchObject({
      PK: "IDEMP#workRequest#assign#user_123",
      SK: "idem_123",
      itemKind: "IDEMPOTENCY_RECORD",
      payloadHash: "payload_hash_123",
      expiresAt: 1782993600,
    });
    expect(fromIdempotencyItem(item)).toMatchObject({
      resourceType: "workRequest",
      commandName: "assign",
      subject: "user_123",
      idempotencyKey: "idem_123",
      response: success,
    });
  });

  it("round-trips projection items", () => {
    const projection = projectionWrite();
    const item = toProjectionItem({
      ...projection,
      resourceType: "workRequest",
      resourceId: "wr_123",
      tenantId: "tenant_123",
      updatedAt: "2026-06-25T12:00:00.000Z",
    });

    expect(unmarshall(item)).toMatchObject({
      PK: "PROJ#workRequest#list",
      SK: "8217611199999#wr_123",
      itemKind: "PROJECTION_ITEM",
      resourceType: "workRequest",
      projectionName: "workRequest.list",
    });
    expect(fromProjectionItem(item)).toMatchObject({
      itemId: "wr_123",
      data: {
        title: "Fix checkout",
        status: "open",
      },
      tenantId: "tenant_123",
    });
  });

  it("round-trips worker idempotency items", () => {
    const item = toWorkerIdempotencyItem({
      workerName: "staleWorkRequestReminder",
      eventId: "evt_123",
      processedAt: "2026-06-25T12:00:00.000Z",
      expiresAt: 1783003200,
    });

    expect(unmarshall(item)).toMatchObject({
      PK: "WORKER#staleWorkRequestReminder#PROCESSED",
      SK: "evt_123",
      itemKind: "WORKER_IDEMPOTENCY",
      expiresAt: 1783003200,
    });
    expect(fromWorkerIdempotencyItem(item)).toMatchObject({
      workerName: "staleWorkRequestReminder",
      eventId: "evt_123",
      processedAt: "2026-06-25T12:00:00.000Z",
    });
  });

  it("builds create command transaction items", () => {
    const transaction = buildCommandTransactWriteItems(commandCommitInput({ create: true }), {
      tableName: "JawStackTable",
      idempotency: {
        commandName: "assign",
        subject: "user_123",
      },
    });

    expect(transaction).toHaveLength(5);
    expect(transaction[0]?.Put?.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(transaction[0]?.Put?.TableName).toBe("JawStackTable");
    expect(transaction[1]?.Put?.Item).toMatchObject({
      PK: { S: "RES#workRequest#wr_123" },
      SK: { S: "ACT#2026-06-25T12:00:00.000Z#act_123" },
    });
    expect(transaction[2]?.Put?.Item).toMatchObject({
      PK: { S: "OUTBOX#evt_123" },
      GSI1PK: { S: "OUTBOX#PENDING" },
    });
    expect(transaction[3]?.Put?.Item).toMatchObject({
      PK: { S: "PROJ#workRequest#list" },
      SK: { S: "8217611199999#wr_123" },
    });
    expect(transaction[4]?.Put?.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(transaction[4]?.Put?.Item).toMatchObject({
      PK: { S: "IDEMP#workRequest#assign#user_123" },
      SK: { S: "idem_123" },
    });
  });

  it("builds update state transaction condition items", () => {
    const transaction = buildResourceStateTransactWriteItem(
      {
        resourceType: "workRequest",
        resourceId: "wr_123",
        expectedVersion: 3,
        next: resourceState({ version: 4 }),
        create: false,
      },
      "JawStackTable",
    );

    expect(transaction.Put?.ConditionExpression).toBe("#version = :expectedVersion");
    expect(transaction.Put?.ExpressionAttributeNames).toEqual({
      "#version": "version",
    });
    expect(transaction.Put?.ExpressionAttributeValues).toEqual({
      ":expectedVersion": {
        N: "3",
      },
    });
  });

  it("builds projection delete transaction items", () => {
    const transaction = buildProjectionTransactWriteItem(
      {
        ...projectionWrite(),
        delete: true,
      },
      {
        resourceType: "workRequest",
        resourceId: "wr_123",
        tenantId: "tenant_123",
        updatedAt: "2026-06-25T12:00:00.000Z",
      },
      "JawStackTable",
    );

    expect(transaction).toEqual({
      Delete: {
        TableName: "JawStackTable",
        Key: {
          PK: {
            S: "PROJ#workRequest#list",
          },
          SK: {
            S: "8217611199999#wr_123",
          },
        },
      },
    });
  });

  it("gets resource state through DynamoDB", async () => {
    const client = new RecordingDynamoDbClient([{ Item: toResourceStateItem(resourceState()) }]);
    const repository = new DynamoDbRepository({
      client,
      tableName: "JawStackTable",
    });

    await expect(repository.getState("workRequest", "wr_123")).resolves.toEqual(resourceState());

    expect(client.commands[0]).toBeInstanceOf(GetItemCommand);
    expect(client.inputs[0]).toMatchObject({
      TableName: "JawStackTable",
      Key: {
        PK: {
          S: "RES#workRequest#wr_123",
        },
        SK: {
          S: "STATE",
        },
      },
      ConsistentRead: true,
    });
  });

  it("returns undefined for missing resource state", async () => {
    const client = new RecordingDynamoDbClient([{}]);
    const repository = new DynamoDbRepository({
      client,
      tableName: "JawStackTable",
    });

    await expect(repository.getState("workRequest", "wr_missing")).resolves.toBeUndefined();
  });

  it("lists projection records through DynamoDB", async () => {
    const client = new RecordingDynamoDbClient([
      {
        Items: [
          toProjectionItem({
            ...projectionWrite(),
            resourceType: "workRequest",
            resourceId: "wr_123",
            updatedAt: "2026-06-25T12:00:00.000Z",
          }),
        ],
      },
    ]);
    const repository = new DynamoDbRepository({
      client,
      tableName: "JawStackTable",
    });

    await expect(repository.listProjection("workRequest.list")).resolves.toEqual([
      projectionWrite(),
    ]);

    expect(client.commands[0]).toBeInstanceOf(QueryCommand);
    expect(client.inputs[0]).toMatchObject({
      TableName: "JawStackTable",
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: {
        ":pk": {
          S: "PROJ#workRequest#list",
        },
      },
      ConsistentRead: true,
    });
  });

  it("lists activity records through DynamoDB", async () => {
    const client = new RecordingDynamoDbClient([
      {
        Items: [toActivityItem(activityRecord())],
      },
    ]);
    const repository = new DynamoDbRepository({
      client,
      tableName: "JawStackTable",
    });

    await expect(repository.getActivity("workRequest", "wr_123")).resolves.toEqual([
      activityRecord(),
    ]);

    expect(client.commands[0]).toBeInstanceOf(QueryCommand);
    expect(client.inputs[0]).toMatchObject({
      TableName: "JawStackTable",
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
      ExpressionAttributeValues: {
        ":pk": {
          S: "RES#workRequest#wr_123",
        },
        ":skPrefix": {
          S: "ACT#",
        },
      },
      ScanIndexForward: true,
    });
  });

  it("gets idempotency records through explicit DynamoDB scope", async () => {
    const success = apiSuccess();
    const client = new RecordingDynamoDbClient([
      {
        Item: toIdempotencyItem(
          idempotencyContextFromCoreRecord(
            {
              key: "idem_123",
              fingerprint: "payload_hash_123",
              response: success,
            },
            {
              resourceType: "workRequest",
              commandName: "assign",
              subject: "user_123",
              resourceId: "wr_123",
              createdAt: "2026-06-25T12:00:00.000Z",
            },
          ),
          success,
        ),
      },
    ]);
    const repository = new DynamoDbRepository({
      client,
      tableName: "JawStackTable",
    });

    await expect(
      repository.getCommandIdempotency({
        resourceType: "workRequest",
        commandName: "assign",
        subject: "user_123",
        idempotencyKey: "idem_123",
      }),
    ).resolves.toEqual({
      key: "idem_123",
      fingerprint: "payload_hash_123",
      response: success,
    });

    expect(client.commands[0]).toBeInstanceOf(GetItemCommand);
    expect(client.inputs[0]).toMatchObject({
      Key: {
        PK: {
          S: "IDEMP#workRequest#assign#user_123",
        },
        SK: {
          S: "idem_123",
        },
      },
    });
  });

  it("gets idempotency records through the scoped core repository method", async () => {
    const success = apiSuccess();
    const client = new RecordingDynamoDbClient([
      {
        Item: toIdempotencyItem(
          idempotencyContextFromCoreRecord(
            {
              key: "idem_123",
              fingerprint: "payload_hash_123",
              response: success,
            },
            {
              resourceType: "workRequest",
              commandName: "assign",
              subject: "user_123",
              createdAt: "2026-06-25T12:00:00.000Z",
            },
          ),
          success,
        ),
      },
    ]);
    const repository = new DynamoDbRepository({
      client,
      tableName: "JawStackTable",
      idempotencyScope: {
        resourceType: "workRequest",
        commandName: "assign",
        subject: "user_123",
      },
    });

    await expect(repository.getIdempotency("idem_123")).resolves.toMatchObject({
      key: "idem_123",
      fingerprint: "payload_hash_123",
    });
  });

  it("commits a command through one DynamoDB transaction", async () => {
    const client = new RecordingDynamoDbClient([{}]);
    const unitOfWork = new DynamoDbCommandUnitOfWork({
      client,
      tableName: "JawStackTable",
      idempotency: {
        commandName: "assign",
        subject: "user_123",
      },
    });

    await expect(unitOfWork.commit(commandCommitInput({ create: true }))).resolves.toBeUndefined();

    expect(client.commands[0]).toBeInstanceOf(TransactWriteItemsCommand);
    expect(client.inputs[0]).toMatchObject({
      TransactItems: [
        {
          Put: {
            TableName: "JawStackTable",
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        {
          Put: {
            TableName: "JawStackTable",
            Item: {
              SK: {
                S: "ACT#2026-06-25T12:00:00.000Z#act_123",
              },
            },
          },
        },
        {
          Put: {
            TableName: "JawStackTable",
            Item: {
              PK: {
                S: "OUTBOX#evt_123",
              },
            },
          },
        },
        {
          Put: {
            TableName: "JawStackTable",
            Item: {
              PK: {
                S: "PROJ#workRequest#list",
              },
            },
          },
        },
        {
          Put: {
            TableName: "JawStackTable",
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
      ],
    });
  });

  it("commits updates with expected version conditions", async () => {
    const client = new RecordingDynamoDbClient([{}]);
    const unitOfWork = new DynamoDbCommandUnitOfWork({
      client,
      tableName: "JawStackTable",
      idempotency: {
        commandName: "assign",
        subject: "user_123",
      },
    });

    await expect(unitOfWork.commit(commandCommitInput({ create: false }))).resolves.toBeUndefined();

    expect(transactItems(client)[0]).toMatchObject({
      Put: {
        ConditionExpression: "#version = :expectedVersion",
        ExpressionAttributeValues: {
          ":expectedVersion": {
            N: "1",
          },
        },
      },
    });
  });

  it("maps duplicate idempotency transaction failures", async () => {
    const client = new RecordingDynamoDbClient([
      transactionCanceled([
        {},
        {},
        {},
        {},
        {
          Code: "ConditionalCheckFailed",
        },
      ]),
    ]);
    const unitOfWork = new DynamoDbCommandUnitOfWork({
      client,
      tableName: "JawStackTable",
      idempotency: {
        commandName: "assign",
        subject: "user_123",
      },
    });

    await expect(unitOfWork.commit(commandCommitInput({ create: true }))).rejects.toMatchObject({
      code: "idempotency.conflict",
    });
  });

  it("maps resource version transaction failures", async () => {
    const client = new RecordingDynamoDbClient([
      transactionCanceled([
        {
          Code: "ConditionalCheckFailed",
        },
        {},
        {},
        {},
        {},
      ]),
    ]);
    const unitOfWork = new DynamoDbCommandUnitOfWork({
      client,
      tableName: "JawStackTable",
      idempotency: {
        commandName: "assign",
        subject: "user_123",
      },
    });

    await expect(unitOfWork.commit(commandCommitInput({ create: false }))).rejects.toMatchObject({
      code: "resource.conflict",
      details: {
        expectedVersion: 1,
      },
    });
  });

  it("publishes events to EventBridge with the full event envelope", async () => {
    const client = new RecordingAwsClient([
      { FailedEntryCount: 0, Entries: [{ EventId: "eb_123" }] },
    ]);
    const publisher = new EventBridgePublisher({
      client,
      eventBusName: "jawstack-dev-events",
      source: "jawstack.dev",
    });

    await expect(publisher.publish(jawStackEvent())).resolves.toBeUndefined();

    expect(client.commands[0]).toBeInstanceOf(PutEventsCommand);
    expect(client.inputs[0]).toEqual({
      Entries: [
        {
          Source: "jawstack.dev",
          DetailType: "workRequest.assigned",
          Detail: JSON.stringify(jawStackEvent()),
          EventBusName: "jawstack-dev-events",
        },
      ],
    });
  });

  it("surfaces EventBridge publish failures", async () => {
    const client = new RecordingAwsClient([
      {
        FailedEntryCount: 1,
        Entries: [
          {
            ErrorCode: "InternalFailure",
            ErrorMessage: "temporary failure",
          },
        ],
      },
    ]);
    const publisher = new EventBridgePublisher({
      client,
      eventBusName: "jawstack-dev-events",
    });

    await expect(publisher.publish(jawStackEvent())).rejects.toMatchObject({
      code: "runtime.unavailable",
      details: {
        errorCode: "InternalFailure",
      },
    });
  });

  it("filters stream records to pending outbox inserts and status changes", () => {
    const pending = toOutboxEventItem(jawStackEvent());
    const published = toOutboxEventItem(jawStackEvent(), {
      status: "PUBLISHED",
      publishedAt: "2026-06-25T12:01:00.000Z",
    });

    expect(
      pendingOutboxItemFromStreamRecord({
        eventName: "INSERT",
        dynamodb: {
          NewImage: pending,
        },
      }),
    ).toMatchObject({
      eventId: "evt_123",
      status: "PENDING",
    });
    expect(
      pendingOutboxItemFromStreamRecord({
        eventName: "MODIFY",
        dynamodb: {
          OldImage: published,
          NewImage: pending,
        },
      }),
    ).toMatchObject({
      eventId: "evt_123",
      status: "PENDING",
    });
    expect(
      pendingOutboxItemFromStreamRecord({
        eventName: "MODIFY",
        dynamodb: {
          OldImage: pending,
          NewImage: pending,
        },
      }),
    ).toBeUndefined();
    expect(
      pendingOutboxItemFromStreamRecord({
        eventName: "INSERT",
        dynamodb: {
          NewImage: toResourceStateItem(resourceState()),
        },
      }),
    ).toBeUndefined();
  });

  it("dispatches pending stream outbox records and marks them published", async () => {
    const dynamoDbClient = new RecordingAwsClient([{}]);
    const eventBridgeClient = new RecordingAwsClient([
      {
        FailedEntryCount: 0,
        Entries: [{ EventId: "eb_123" }],
      },
    ]);
    const dispatcher = new DynamoDbOutboxDispatcher({
      dynamoDbClient,
      tableName: "JawStackTable",
      publisher: new EventBridgePublisher({
        client: eventBridgeClient,
        eventBusName: "jawstack-dev-events",
        source: "jawstack.dev",
      }),
      clock: () => new Date("2026-06-25T12:02:00.000Z"),
    });

    await expect(
      dispatcher.dispatchStream({
        Records: [
          {
            eventName: "INSERT",
            dynamodb: {
              NewImage: toOutboxEventItem(jawStackEvent()),
            },
          },
        ],
      }),
    ).resolves.toEqual({
      seen: 1,
      ignored: 0,
      published: 1,
      markedPublished: 1,
    });

    expect(eventBridgeClient.commands[0]).toBeInstanceOf(PutEventsCommand);
    expect(dynamoDbClient.commands[0]).toBeInstanceOf(UpdateItemCommand);
    expect(dynamoDbClient.inputs[0]).toMatchObject({
      TableName: "JawStackTable",
      Key: {
        PK: {
          S: "OUTBOX#evt_123",
        },
        SK: {
          S: "EVENT",
        },
      },
      ConditionExpression: "#status = :pending",
      ExpressionAttributeValues: {
        ":published": {
          S: "PUBLISHED",
        },
        ":publishedAt": {
          S: "2026-06-25T12:02:00.000Z",
        },
        ":gsi1pk": {
          S: "OUTBOX#PUBLISHED",
        },
        ":gsi1sk": {
          S: "2026-06-25T12:02:00.000Z#evt_123",
        },
      },
    });
  });

  it("ignores non-outbox stream records", async () => {
    const dynamoDbClient = new RecordingAwsClient([]);
    const eventBridgeClient = new RecordingAwsClient([]);
    const dispatcher = new DynamoDbOutboxDispatcher({
      dynamoDbClient,
      tableName: "JawStackTable",
      publisher: new EventBridgePublisher({
        client: eventBridgeClient,
        eventBusName: "jawstack-dev-events",
      }),
    });

    await expect(
      dispatcher.dispatchStream({
        Records: [
          {
            eventName: "INSERT",
            dynamodb: {
              NewImage: toResourceStateItem(resourceState()),
            },
          },
          {
            eventName: "MODIFY",
            dynamodb: {
              NewImage: toOutboxEventItem(jawStackEvent(), {
                status: "PUBLISHED",
                publishedAt: "2026-06-25T12:03:00.000Z",
              }),
            },
          },
        ],
      }),
    ).resolves.toEqual({
      seen: 2,
      ignored: 2,
      published: 0,
      markedPublished: 0,
    });
    expect(eventBridgeClient.commands).toHaveLength(0);
    expect(dynamoDbClient.commands).toHaveLength(0);
  });

  it("treats already-published outbox update conflicts as dispatched", async () => {
    const dynamoDbClient = new RecordingAwsClient([conditionalFailure()]);
    const eventBridgeClient = new RecordingAwsClient([
      {
        FailedEntryCount: 0,
        Entries: [{ EventId: "eb_123" }],
      },
    ]);
    const dispatcher = new DynamoDbOutboxDispatcher({
      dynamoDbClient,
      tableName: "JawStackTable",
      publisher: new EventBridgePublisher({
        client: eventBridgeClient,
        eventBusName: "jawstack-dev-events",
      }),
      clock: () => new Date("2026-06-25T12:02:00.000Z"),
    });

    await expect(
      dispatcher.dispatchStream({
        Records: [
          {
            eventName: "INSERT",
            dynamodb: {
              NewImage: toOutboxEventItem(jawStackEvent()),
            },
          },
        ],
      }),
    ).resolves.toEqual({
      seen: 1,
      ignored: 0,
      published: 1,
      markedPublished: 0,
    });
  });

  it("surfaces dispatcher publish failures before marking published", async () => {
    const dynamoDbClient = new RecordingAwsClient([]);
    const eventBridgeClient = new RecordingAwsClient([
      {
        FailedEntryCount: 1,
        Entries: [{ ErrorCode: "InternalFailure" }],
      },
    ]);
    const dispatcher = new DynamoDbOutboxDispatcher({
      dynamoDbClient,
      tableName: "JawStackTable",
      publisher: new EventBridgePublisher({
        client: eventBridgeClient,
        eventBusName: "jawstack-dev-events",
      }),
    });

    await expect(
      dispatcher.dispatchStream({
        Records: [
          {
            eventName: "INSERT",
            dynamodb: {
              NewImage: toOutboxEventItem(jawStackEvent()),
            },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: "runtime.unavailable",
    });
    expect(dynamoDbClient.commands).toHaveLength(0);
  });

  it("sweeps stale pending outbox records with the configured batch limit", async () => {
    const staleEvent = jawStackEvent({
      eventId: "evt_stale",
      occurredAt: "2026-06-25T12:00:00.000Z",
    });
    const dynamoDbClient = new RecordingAwsClient([
      {
        Items: [toOutboxEventItem(staleEvent)],
      },
      {},
    ]);
    const eventBridgeClient = new RecordingAwsClient([
      {
        FailedEntryCount: 0,
        Entries: [{ EventId: "eb_stale" }],
      },
    ]);
    const sweeper = new DynamoDbOutboxSweeper({
      dynamoDbClient,
      tableName: "JawStackTable",
      publisher: new EventBridgePublisher({
        client: eventBridgeClient,
        eventBusName: "jawstack-dev-events",
      }),
      clock: () => new Date("2026-06-25T12:05:00.000Z"),
      batchLimit: 1,
    });

    await expect(sweeper.sweep()).resolves.toEqual({
      seen: 1,
      ignored: 0,
      published: 1,
      markedPublished: 1,
    });

    expect(dynamoDbClient.commands[0]).toBeInstanceOf(QueryCommand);
    expect(dynamoDbClient.inputs[0]).toMatchObject({
      TableName: "JawStackTable",
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :status AND GSI1SK < :staleBefore",
      Limit: 1,
      ExpressionAttributeValues: {
        ":status": {
          S: "OUTBOX#PENDING",
        },
        ":staleBefore": {
          S: "2026-06-25T12:03:00.000Z#~",
        },
      },
    });
    expect(dynamoDbClient.commands[1]).toBeInstanceOf(UpdateItemCommand);
    expect(eventBridgeClient.commands[0]).toBeInstanceOf(PutEventsCommand);
  });

  it("creates a generated-compatible Lambda HTTP handler", async () => {
    const fixture = lambdaFixture();
    const handler = createLambdaHttpHandler(fixture.options);

    const response = await handler(lambdaEvent("GET", "/api/health"));

    expect(response.statusCode).toBe(200);
    expect(jsonBody(response)).toMatchObject({
      ok: true,
      data: {
        status: "ok",
      },
    });
  });

  it("serves manifest, list, detail, and activity routes through Lambda", async () => {
    const fixture = lambdaFixture();
    const handler = createApiGatewayLambdaHandler(fixture.options);

    await handler(
      lambdaEvent("POST", "/api/resources/workRequest/commands/create", {
        body: {
          input: {
            title: "Fix checkout",
          },
        },
      }),
    );

    const manifest = await handler(lambdaEvent("GET", "/api/manifest"));
    const list = await handler(lambdaEvent("GET", "/api/resources/workRequest"));
    const detail = await handler(lambdaEvent("GET", "/api/resources/workRequest/wr_lambda"));
    const activity = await handler(
      lambdaEvent("GET", "/api/resources/workRequest/wr_lambda/activity"),
    );

    expect(manifest.statusCode).toBe(200);
    expect(jsonBody(manifest)).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 1,
        appName: "lambda-test",
      },
    });
    expect(jsonBody(list)).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            itemId: "wr_lambda",
          },
        ],
      },
    });
    expect(jsonBody(detail)).toMatchObject({
      ok: true,
      data: {
        resourceId: "wr_lambda",
        state: {
          title: "Fix checkout",
        },
      },
    });
    expect(jsonBody(activity)).toMatchObject({
      ok: true,
      data: {
        items: [
          {
            activityId: "act_lambda",
          },
        ],
      },
    });
  });

  it("runs create commands through the Lambda adapter", async () => {
    const fixture = lambdaFixture();
    const response = await createApiGatewayLambdaHandler(fixture.options)(
      lambdaEvent("POST", "/api/resources/workRequest/commands/create", {
        body: {
          input: {
            title: "Fix checkout",
          },
        },
        headers: {
          "x-jawstack-request-id": "req_header",
          "x-jawstack-correlation-id": "corr_header",
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(jsonBody(response)).toMatchObject({
      ok: true,
      data: {
        resourceId: "wr_lambda",
        status: "open",
      },
      meta: {
        requestId: "req_header",
        correlationId: "corr_header",
      },
    });
  });

  it("passes command idempotency scope to the Lambda repository factory", async () => {
    const scopes: unknown[] = [];
    const fixture = lambdaFixture({
      onRepositoryFactoryInput: (input) => {
        scopes.push(input.idempotencyScope);
      },
    });
    const handler = createApiGatewayLambdaHandler(fixture.options);

    await handler(
      lambdaEvent("POST", "/api/resources/workRequest/commands/create", {
        body: {
          input: {
            title: "Fix checkout",
          },
          idempotencyKey: "idem_lambda",
        },
      }),
    );

    expect(scopes).toContainEqual({
      resourceType: "workRequest",
      commandName: "create",
      subject: "user_123",
    });
  });

  it("maps Lambda command validation failures", async () => {
    const fixture = lambdaFixture();
    const response = await createApiGatewayLambdaHandler(fixture.options)(
      lambdaEvent("POST", "/api/resources/workRequest/commands/create", {
        body: {
          input: {
            title: "",
          },
        },
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(jsonBody(response)).toMatchObject({
      ok: false,
      error: {
        code: "command.validation",
      },
    });
  });

  it("maps Lambda auth failures", async () => {
    const fixture = lambdaFixture({
      authProvider: new HeaderAuthProvider(),
    });
    const response = await createApiGatewayLambdaHandler(fixture.options)(
      lambdaEvent("GET", "/api/resources/workRequest", {
        headers: {},
      }),
    );

    expect(response.statusCode).toBe(401);
    expect(jsonBody(response)).toMatchObject({
      ok: false,
      error: {
        code: "auth.missing",
      },
    });
  });

  it("maps missing Lambda resources", async () => {
    const fixture = lambdaFixture();
    const response = await createApiGatewayLambdaHandler(fixture.options)(
      lambdaEvent("GET", "/api/resources/workRequest/wr_missing"),
    );

    expect(response.statusCode).toBe(404);
    expect(jsonBody(response)).toMatchObject({
      ok: false,
      error: {
        code: "resource.not_found",
      },
    });
  });

  it("skips already-processed SQS worker events", async () => {
    const dynamoDbClient = new RecordingDynamoDbClient([
      {
        Item: toWorkerIdempotencyItem({
          workerName: "sendNotification",
          eventId: "evt_123",
          processedAt: "2026-06-25T12:00:00.000Z",
          expiresAt: 1783003200,
        }),
      },
    ]);
    const handled: unknown[] = [];
    const adapter = new SqsWorkerAdapter({
      workerName: "sendNotification",
      idempotencyStore: new DynamoDbWorkerIdempotencyStore({
        client: dynamoDbClient,
        tableName: "JawStackTable",
      }),
      handler: (message) => {
        handled.push(message);
      },
    });

    await expect(adapter.handle(sqsEvent(jawStackEvent()))).resolves.toEqual({
      seen: 1,
      processed: 0,
      skipped: 1,
    });
    expect(handled).toHaveLength(0);
    expect(dynamoDbClient.commands[0]).toBeInstanceOf(GetItemCommand);
    expect(dynamoDbClient.commands).toHaveLength(1);
  });

  it("processes SQS worker events and writes processed markers", async () => {
    const dynamoDbClient = new RecordingDynamoDbClient([{}, {}]);
    const handled: unknown[] = [];
    const adapter = new SqsWorkerAdapter({
      workerName: "sendNotification",
      idempotencyStore: new DynamoDbWorkerIdempotencyStore({
        client: dynamoDbClient,
        tableName: "JawStackTable",
        clock: () => new Date("2026-06-25T12:00:00.000Z"),
      }),
      clock: () => new Date("2026-06-25T12:00:01.000Z"),
      handler: (message) => {
        handled.push(message);
      },
    });

    await expect(adapter.handle(sqsEvent(jawStackEvent()))).resolves.toEqual({
      seen: 1,
      processed: 1,
      skipped: 0,
    });
    expect(handled).toMatchObject([
      {
        messageId: "msg_123",
        receivedAt: "2026-06-25T12:00:01.000Z",
        event: {
          eventId: "evt_123",
        },
      },
    ]);
    expect(dynamoDbClient.commands[0]).toBeInstanceOf(GetItemCommand);
    expect(dynamoDbClient.commands[1]).toBeInstanceOf(PutItemCommand);
    expect(dynamoDbClient.inputs[1]).toMatchObject({
      TableName: "JawStackTable",
      ConditionExpression: "attribute_not_exists(PK)",
      Item: {
        PK: {
          S: "WORKER#sendNotification#PROCESSED",
        },
        SK: {
          S: "evt_123",
        },
        expiresAt: {
          N: "1783598400",
        },
      },
    });
  });

  it("processes EventBridge-wrapped SQS worker events", async () => {
    const dynamoDbClient = new RecordingDynamoDbClient([{}, {}]);
    const handled: unknown[] = [];
    const adapter = new SqsWorkerAdapter({
      workerName: "sendNotification",
      idempotencyStore: new DynamoDbWorkerIdempotencyStore({
        client: dynamoDbClient,
        tableName: "JawStackTable",
      }),
      handler: (message) => {
        handled.push(message.event);
      },
    });

    await expect(adapter.handle(sqsEventFromEventBridge(jawStackEvent()))).resolves.toMatchObject({
      seen: 1,
      processed: 1,
      skipped: 0,
    });
    expect(handled).toMatchObject([
      {
        eventId: "evt_123",
        eventType: "workRequest.assigned",
      },
    ]);
  });

  it("does not rethrow duplicate processed marker writes after handler success", async () => {
    const dynamoDbClient = new RecordingDynamoDbClient([{}, conditionalFailure()]);
    const adapter = new SqsWorkerAdapter({
      workerName: "sendNotification",
      idempotencyStore: new DynamoDbWorkerIdempotencyStore({
        client: dynamoDbClient,
        tableName: "JawStackTable",
      }),
      handler: () => undefined,
    });

    await expect(adapter.handle(sqsEvent(jawStackEvent()))).resolves.toEqual({
      seen: 1,
      processed: 0,
      skipped: 1,
    });
  });
});

function resourceState(
  overrides: Partial<ResourceState<Record<string, unknown>>> = {},
): ResourceState<Record<string, unknown>> {
  return {
    resourceType: "workRequest",
    resourceId: "wr_123",
    version: 1,
    state: {
      title: "Fix checkout",
      status: "open",
    },
    createdAt: "2026-06-25T12:00:00.000Z",
    updatedAt: "2026-06-25T12:00:00.000Z",
    createdBy: "user_123",
    updatedBy: "user_123",
    tenantId: "tenant_123",
    ...overrides,
  };
}

function activityRecord(): ActivityRecord {
  return {
    activityId: "act_123",
    resourceType: "workRequest",
    resourceId: "wr_123",
    activityType: "workRequest.assigned",
    title: "Assigned work request",
    summary: "Assigned to Jamie",
    data: {
      assigneeId: "user_456",
    },
    actor: {
      subject: "user_123",
      displayName: "Avery",
    },
    tenantId: "tenant_123",
    correlationId: "corr_123",
    causationId: "req_123",
    occurredAt: "2026-06-25T12:00:00.000Z",
  };
}

function jawStackEvent(
  overrides: Partial<JawStackEvent<Record<string, unknown>>> = {},
): JawStackEvent<Record<string, unknown>> {
  return {
    envelopeVersion: 1,
    eventId: "evt_123",
    eventType: "workRequest.assigned",
    schemaVersion: 1,
    source: "jawstack.test",
    resourceType: "workRequest",
    resourceId: "wr_123",
    tenantId: "tenant_123",
    actor: {
      subject: "user_123",
      displayName: "Avery",
    },
    correlationId: "corr_123",
    causationId: "req_123",
    occurredAt: "2026-06-25T12:00:00.000Z",
    payload: {
      assigneeId: "user_456",
    },
    ...overrides,
  };
}

function projectionWrite(): ProjectionWrite {
  return {
    projectionName: "workRequest.list",
    itemId: "wr_123",
    sort: invertedTimestamp("2026-06-25T12:00:00.000Z"),
    data: {
      title: "Fix checkout",
      status: "open",
    },
  };
}

function apiSuccess(): ApiSuccess<{ resourceId: string }> {
  return {
    ok: true,
    data: {
      resourceId: "wr_123",
    },
    meta: {
      requestId: "req_123",
      correlationId: "corr_123",
    },
  };
}

function commandCommitInput(options: {
  create: boolean;
}): CommandCommitInput<Record<string, unknown>, { resourceId: string }> {
  return {
    resource: {
      resourceType: "workRequest",
      resourceId: "wr_123",
      ...(options.create ? {} : { expectedVersion: 1 }),
      next: resourceState(),
      create: options.create,
    },
    activity: [activityRecord()],
    outbox: [jawStackEvent()],
    projections: [projectionWrite()],
    response: {
      resourceId: "wr_123",
    },
    idempotency: {
      key: "idem_123",
      fingerprint: "payload_hash_123",
      response: apiSuccess(),
    },
  };
}

function lambdaFixture(
  overrides: Partial<{
    authProvider: LambdaHttpAdapterOptions["authProvider"];
    onRepositoryFactoryInput: (input: LambdaRepositoryFactoryInput) => void;
  }> = {},
): Readonly<{
  options: LambdaHttpAdapterOptions;
}> {
  const persistence = createInMemoryPersistence();
  const authProvider =
    overrides.authProvider ??
    new TestAuthProvider({
      subject: "user_123",
      displayName: "Avery",
      tenantId: "tenant_123",
      roles: ["user", "manager"],
      claims: {},
      mode: "test",
    } satisfies AuthContext);

  return {
    options: {
      appName: "lambda-test",
      stage: "dev",
      registry: [workRequestResource],
      repository: persistence.repository,
      unitOfWork: persistence.unitOfWork,
      authProvider,
      clock: () => new Date("2026-06-25T12:00:00.000Z"),
      source: "jawstack.test",
      ids: {
        resourceId: () => "wr_lambda",
        eventId: () => "evt_lambda",
        activityId: () => "act_lambda",
        requestId: () => "req_generated",
        correlationId: () => "corr_generated",
      },
      ...(overrides.onRepositoryFactoryInput === undefined
        ? {}
        : {
            repositoryFactory: (input) => {
              overrides.onRepositoryFactoryInput?.(input);
              return persistence.repository;
            },
          }),
    },
  };
}

function lambdaEvent(
  method: string,
  path: string,
  options: Partial<{
    headers: Record<string, string>;
    body: unknown;
    requestId: string;
  }> = {},
): LambdaHttpEvent {
  return {
    version: "2.0",
    rawPath: path,
    rawQueryString: "",
    headers: {
      "x-jawstack-request-id": "req_lambda",
      "x-jawstack-correlation-id": "corr_lambda",
      ...(options.headers ?? {}),
    },
    requestContext: {
      requestId: options.requestId ?? "lambda_request",
      http: {
        method,
        path,
      },
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    isBase64Encoded: false,
  };
}

function jsonBody(response: LambdaHttpResponse): unknown {
  return JSON.parse(response.body) as unknown;
}

function sqsEvent(
  event: JawStackEvent,
): Readonly<{ Records: readonly [{ messageId: string; body: string }] }> {
  return {
    Records: [
      {
        messageId: "msg_123",
        body: JSON.stringify(event),
      },
    ],
  };
}

function sqsEventFromEventBridge(
  event: JawStackEvent,
): Readonly<{ Records: readonly [{ messageId: string; body: string }] }> {
  return {
    Records: [
      {
        messageId: "msg_123",
        body: JSON.stringify({
          source: "jawstack.test",
          "detail-type": event.eventType,
          detail: event,
        }),
      },
    ],
  };
}

class RecordingAwsClient {
  readonly commands: unknown[] = [];
  readonly inputs: unknown[] = [];
  private readonly results: unknown[];

  constructor(results: unknown[]) {
    this.results = [...results];
  }

  async send(command: Readonly<{ input: unknown }>): Promise<unknown> {
    this.commands.push(command);
    this.inputs.push(command.input);

    const result = this.results.shift() ?? {};

    if (result instanceof Error) {
      throw result;
    }

    return result;
  }
}

class RecordingDynamoDbClient extends RecordingAwsClient {}

function conditionalFailure(): Error {
  const error = new Error("Conditional check failed");
  error.name = "ConditionalCheckFailedException";
  return error;
}

function transactionCanceled(
  cancellationReasons: ReadonlyArray<Readonly<{ Code?: string }>>,
): Error {
  const error = new Error("Transaction cancelled");
  error.name = "TransactionCanceledException";
  Object.assign(error, {
    CancellationReasons: cancellationReasons,
  });
  return error;
}

function transactItems(client: RecordingDynamoDbClient): unknown[] {
  const input = client.inputs[0];

  if (typeof input !== "object" || input === null || !("TransactItems" in input)) {
    return [];
  }

  return Array.isArray(input.TransactItems) ? input.TransactItems : [];
}
