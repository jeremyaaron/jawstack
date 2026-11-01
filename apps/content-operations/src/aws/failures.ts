import { GetItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  DynamoDbRepository,
  toProjectionItem,
  toOutboxEventItem,
  type DynamoDbClientLike,
  type DynamoDbItem,
} from "@jawstack/aws-runtime";
import { JawStackRuntimeError } from "@jawstack/core";
import {
  failureKey,
  failureProjection,
  failureQuery,
  parseFailureRecord,
  validateFailureChange,
  type FailureStore,
} from "../application/failure-records";

export function createDynamoFailureStore(options: {
  client: DynamoDbClientLike;
  tableName: string;
  source: string;
}): FailureStore {
  const repository = new DynamoDbRepository(options);
  const get: FailureStore["get"] = async (id) => {
    const key = failureKey(id);
    try {
      const result = (await options.client.send(
        new GetItemCommand({
          TableName: options.tableName,
          Key: marshall(key),
          ConsistentRead: true,
        }),
      )) as { Item?: DynamoDbItem };
      if (!result.Item) return undefined;
      const { PK, SK, itemKind, ...data } = unmarshall(result.Item);
      if (PK !== key.PK || SK !== key.SK || itemKind !== "APP_FAILURE")
        throw new JawStackRuntimeError(
          "resource.invalid_state",
          "Failed-delivery key/kind mismatch.",
        );
      const record = parseFailureRecord(data, options.source);
      if (record.id !== id)
        throw new JawStackRuntimeError(
          "resource.invalid_state",
          "Failed-delivery identity mismatch.",
        );
      return record;
    } catch (error) {
      if (error instanceof JawStackRuntimeError) throw error;
      throw new JawStackRuntimeError("runtime.unavailable", "Failed-delivery read failed.");
    }
  };
  return {
    get,
    query: async (input) => repository.queryProjection(failureQuery(input)),
    commit: async (expectedVersion, input, replay) => {
      const record = parseFailureRecord(input, options.source);
      const previous = await get(record.id);
      if ((previous?.version ?? null) !== expectedVersion)
        throw new JawStackRuntimeError("resource.conflict", "Failed-delivery version changed.");
      validateFailureChange(previous, record, replay);
      const first = {
        Put: {
          TableName: options.tableName,
          Item: marshall({ ...failureKey(record.id), itemKind: "APP_FAILURE", ...record }),
          ConditionExpression:
            expectedVersion === null ? "attribute_not_exists(PK)" : "#version = :expectedVersion",
          ...(expectedVersion === null
            ? {}
            : {
                ExpressionAttributeNames: { "#version": "version" },
                ExpressionAttributeValues: marshall({ ":expectedVersion": expectedVersion }),
              }),
        },
      };
      const view = {
        Put: {
          TableName: options.tableName,
          Item: toProjectionItem({
            ...failureProjection(record),
            resourceType: "contentItem",
            resourceId: record.original.resourceId,
            updatedAt: record.firstCollectedAt,
          }),
          ...(expectedVersion === null ? { ConditionExpression: "attribute_not_exists(PK)" } : {}),
        },
      };
      try {
        await options.client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              first,
              view,
              ...(replay
                ? [
                    {
                      Put: {
                        TableName: options.tableName,
                        Item: toOutboxEventItem(replay),
                        ConditionExpression: "attribute_not_exists(PK)",
                      },
                    },
                  ]
                : []),
            ],
          }),
        );
      } catch (error) {
        const failure = error as { name?: string; CancellationReasons?: { Code?: string }[] };
        throw new JawStackRuntimeError(
          failure?.name === "ConditionalCheckFailedException" ||
            failure?.CancellationReasons?.some((r) => r.Code === "ConditionalCheckFailed")
            ? "resource.conflict"
            : "runtime.unavailable",
          "Failed-delivery transaction did not complete.",
        );
      }
    },
  };
}
