import { unmarshall } from "@aws-sdk/util-dynamodb";
import type {
  ActivityRecord,
  ApiSuccess,
  CommandCommitInput,
  JawStackEvent,
  ProjectionWrite,
  ResourceState,
} from "@jawstack/core";
import { describe, expect, it } from "vitest";

import {
  activityKey,
  buildCommandTransactWriteItems,
  buildProjectionTransactWriteItem,
  buildResourceStateTransactWriteItem,
  describePackage,
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
  projectionKey,
  resourceStateKey,
  toActivityItem,
  toIdempotencyItem,
  toOutboxEventItem,
  toProjectionItem,
  toResourceStateItem,
  toWorkerIdempotencyItem,
  workerIdempotencyKey,
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

function jawStackEvent(): JawStackEvent<Record<string, unknown>> {
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
