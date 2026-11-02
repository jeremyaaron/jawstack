import { createHash } from "node:crypto";
import {
  type TransactWriteItem,
  type TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  JawStackRuntimeError,
  type WorkflowCommitPlan,
  type WorkflowCommitPlanner,
} from "@jawstack/core";
import {
  toActivityItem,
  toIdempotencyItem,
  toOutboxEventItem,
  toProjectionItem,
  toResourceStateItem,
  type DynamoDbItem,
} from "../index";

export type ConditionRole = "idempotency" | "resource";
export const absent = { ConditionExpression: "attribute_not_exists(PK)" } as const;
export const expired = (nowSeconds: number) => ({
  ConditionExpression: "attribute_not_exists(PK) OR #expires <= :now",
  ExpressionAttributeNames: { "#expires": "expiresAt" },
  ExpressionAttributeValues: marshall({ ":now": nowSeconds }),
});
export const version = (expectedVersion: number) => ({
  ConditionExpression: "#version = :expectedVersion",
  ExpressionAttributeNames: { "#version": "version" },
  ExpressionAttributeValues: marshall({ ":expectedVersion": expectedVersion }),
});
function rejected(): never {
  throw new JawStackRuntimeError(
    "command.rejected",
    "DynamoDB workflow transaction exceeds its bounds.",
  );
}

// Conservative encoded-JSON bounds include attribute wrappers and request overhead.
// Nothing is split: all categories must fit one atomic request.
export function boundedTransaction(
  items: TransactWriteItem[],
  roles: ConditionRole[],
  deletedBytes = 0,
): { input: TransactWriteItemsCommandInput; roles: readonly ConditionRole[] } {
  if (
    !items.length ||
    items.length > 60 ||
    items.length !== roles.length ||
    !Number.isSafeInteger(deletedBytes) ||
    deletedBytes < 0
  )
    rejected();
  const keys = new Set<string>();
  for (const item of items) {
    const operation = item.Put ?? item.Delete;
    const key = item.Put?.Item ?? item.Delete?.Key;
    if (!operation || !key || !key.PK?.S || !key.SK?.S) rejected();
    const identity = JSON.stringify([operation.TableName, key.PK.S, key.SK.S]);
    if (keys.has(identity)) rejected();
    keys.add(identity);
    if (item.Put && Buffer.byteLength(JSON.stringify(item.Put.Item)) > 400 * 1024) rejected();
  }
  const serialized = JSON.stringify({ TransactItems: items });
  const input = {
    TransactItems: items,
    ClientRequestToken: createHash("sha256").update(serialized).digest("hex").slice(0, 36),
  };
  if (Buffer.byteLength(JSON.stringify(input)) + deletedBytes > 4 * 1024 * 1024) rejected();
  return { input, roles: Object.freeze([...roles]) };
}

export function compileWorkflowCommit(
  planner: WorkflowCommitPlanner,
  input: WorkflowCommitPlan,
  tableName: string,
) {
  const plan = planner.validate(input);
  const primary = plan.actions.find((action) => action.kind === "resource");
  if (!primary || primary.kind !== "resource") rejected();
  const items: TransactWriteItem[] = [],
    roles: ConditionRole[] = [];
  for (const action of plan.actions) {
    roles.push(action.kind === "idempotency" ? "idempotency" : "resource");
    if (action.kind === "projectionDelete") {
      items.push({
        Delete: {
          TableName: tableName,
          Key: marshall({ PK: action.key.partition, SK: action.key.sort }),
        },
      });
      continue;
    }
    let item: DynamoDbItem;
    let condition: Partial<NonNullable<TransactWriteItem["Put"]>> = {};
    switch (action.kind) {
      case "resource":
        item = toResourceStateItem(action.value);
        condition =
          action.condition.kind === "absent" ? absent : version(action.condition.expectedVersion);
        break;
      case "activity":
        item = toActivityItem(action.value);
        condition = absent;
        break;
      case "outbox":
        item = toOutboxEventItem(action.value);
        condition = absent;
        break;
      case "projection":
        item = toProjectionItem({
          ...action.value,
          resourceType: plan.scope.resourceType,
          resourceId: primary.value.resourceId,
          updatedAt: plan.now,
        });
        break;
      case "idempotency":
        item = toIdempotencyItem(
          {
            ...plan.scope,
            idempotencyKey: action.value.key,
            payloadHash: action.value.fingerprint,
            resourceId: primary.value.resourceId,
            createdAt: action.value.createdAt,
            expiresAt: action.value.expiresAt,
          },
          action.value.response,
        );
        condition = expired(action.condition.nowSeconds);
        break;
      case "record":
        item = marshall({
          PK: action.key.partition,
          SK: action.key.sort,
          itemKind: "APP_OPERATION",
          ...(action.value as Record<string, unknown>),
        });
        condition = absent;
        break;
    }
    if (item.PK?.S !== action.key.partition || item.SK?.S !== action.key.sort) rejected();
    items.push({ Put: { TableName: tableName, Item: item, ...condition } });
  }
  return boundedTransaction(items, roles);
}

export function transactionError(error: unknown, roles: readonly ConditionRole[]): never {
  if (error instanceof JawStackRuntimeError) throw error;
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "TransactionCanceledException" &&
    "CancellationReasons" in error
  ) {
    const reasons = error.CancellationReasons;
    if (
      Array.isArray(reasons) &&
      reasons.length === roles.length &&
      reasons.every(
        (reason: unknown) =>
          reason &&
          typeof reason === "object" &&
          "Code" in reason &&
          ["None", "ConditionalCheckFailed"].includes(String(reason.Code)),
      )
    ) {
      const failed = reasons.map((reason: { Code: string }, index) =>
        reason.Code === "ConditionalCheckFailed" ? roles[index] : undefined,
      );
      if (failed.includes("idempotency"))
        throw new JawStackRuntimeError(
          "idempotency.conflict",
          "Scoped idempotency condition failed.",
        );
      if (failed.includes("resource"))
        throw new JawStackRuntimeError("resource.conflict", "Workflow condition failed.");
    }
  }
  throw new JawStackRuntimeError("runtime.unavailable", "Workflow storage is unavailable.");
}
