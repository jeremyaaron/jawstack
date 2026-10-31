import { GetItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  DynamoDbRepository,
  fromIdempotencyItem,
  idempotencyKey,
  type DynamoDbClientLike,
} from "@jawstack/aws-runtime";
import { JawStackRuntimeError } from "@jawstack/core";
import {
  captureScope,
  prepareTransaction,
  type PersistenceFactory,
} from "../application/persistence";

export function createDynamoPersistence(options: {
  client: DynamoDbClientLike;
  tableName: string;
}): PersistenceFactory {
  return (context, instant) => {
    const scope = captureScope(context);
    const now = new Date(instant);
    const base = new DynamoDbRepository({ ...options, consistentRead: true });
    return {
      repository: {
        getState: (type, id) => base.getState(type, id),
        getIdempotency: async (key) => {
          const output = (await options.client.send(
            new GetItemCommand({
              TableName: options.tableName,
              Key: marshall(idempotencyKey({ ...scope, idempotencyKey: key })),
              ConsistentRead: true,
            }),
          )) as { Item?: Parameters<typeof fromIdempotencyItem>[0] };
          if (!output.Item) return undefined;
          const record = fromIdempotencyItem(output.Item);
          if (!Number.isSafeInteger(record.expiresAt))
            throw new JawStackRuntimeError("runtime.unavailable", "Invalid idempotency expiry.");
          if (record.expiresAt <= Math.floor(now.getTime() / 1000)) return undefined;
          return { key, fingerprint: record.payloadHash, response: record.response };
        },
      },
      unitOfWork: {
        commit: async (input) => {
          const plan = prepareTransaction(input, scope, now, options.tableName);
          try {
            await options.client.send(new TransactWriteItemsCommand({ TransactItems: plan.items }));
          } catch (error) {
            const failure = (typeof error === "object" && error !== null ? error : {}) as {
              name?: string;
              CancellationReasons?: { Code?: string }[];
            };
            const reasons = failure.CancellationReasons ?? [];
            if (reasons[plan.idempotencyIndex]?.Code === "ConditionalCheckFailed")
              throw new JawStackRuntimeError(
                "idempotency.conflict",
                "Idempotency key was already committed.",
              );
            if (
              failure.name === "ConditionalCheckFailedException" ||
              reasons.some((r) => r.Code === "ConditionalCheckFailed")
            )
              throw new JawStackRuntimeError(
                "resource.conflict",
                "An atomic write condition failed.",
              );
            throw new JawStackRuntimeError(
              "runtime.unavailable",
              "DynamoDB command commit failed.",
            );
          }
        },
      },
    };
  };
}
