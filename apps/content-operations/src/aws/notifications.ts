import { GetItemCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  DynamoDbRepository,
  toProjectionItem,
  type DynamoDbClientLike,
} from "@jawstack/aws-runtime";
import { JawStackRuntimeError } from "@jawstack/core";
import {
  notificationKey,
  notificationOperation,
  notificationOperationKey,
  notificationProjectionQuery,
  notificationProjections,
  notificationSchema,
  sameNotification,
  type NotificationSink,
} from "../application/notifications";

export function createDynamoNotificationSink(options: {
  client: DynamoDbClientLike;
  tableName: string;
}): NotificationSink {
  const repository = new DynamoDbRepository({ ...options, consistentRead: true });
  const get = async (id: string) => {
    let result: { Item?: Parameters<typeof unmarshall>[0] };
    try {
      result = (await options.client.send(
        new GetItemCommand({
          TableName: options.tableName,
          Key: marshall(notificationKey(id)),
          ConsistentRead: true,
        }),
      )) as { Item?: Parameters<typeof unmarshall>[0] };
    } catch {
      throw new JawStackRuntimeError("runtime.unavailable", "Notification read failed.");
    }
    if (!result.Item) return undefined;
    const data = unmarshall(result.Item);
    if (
      data.PK !== notificationKey(id).PK ||
      data.SK !== "DELIVERY" ||
      data.itemKind !== "APP_NOTIFICATION"
    )
      throw new JawStackRuntimeError(
        "resource.invalid_state",
        "Stored notification key/kind is invalid.",
      );
    delete data.PK;
    delete data.SK;
    delete data.itemKind;
    const parsed = notificationSchema.safeParse(data);
    if (!parsed.success || parsed.data.deliveryId !== id)
      throw new JawStackRuntimeError("resource.invalid_state", "Stored notification is invalid.");
    return parsed.data;
  };
  return {
    get,
    query: async (query) => repository.queryProjection(notificationProjectionQuery(query)),
    deliver: async (input) => {
      const delivery = notificationSchema.parse(input);
      const previous = await get(delivery.deliveryId);
      if (previous) return sameNotification(previous, delivery);
      const items = [
        marshall({
          ...notificationKey(delivery.deliveryId),
          itemKind: "APP_NOTIFICATION",
          ...delivery,
        }),
        marshall({
          ...notificationOperationKey(delivery.deliveryId),
          itemKind: "APP_OPERATION",
          ...notificationOperation(delivery),
        }),
        ...notificationProjections(delivery).map((projection) =>
          toProjectionItem({
            ...projection,
            resourceType: "contentItem",
            resourceId: delivery.contentId,
            updatedAt: delivery.deliveredAt,
          }),
        ),
      ];
      try {
        await options.client.send(
          new TransactWriteItemsCommand({
            TransactItems: items.map((Item) => ({
              Put: {
                TableName: options.tableName,
                Item,
                ConditionExpression: "attribute_not_exists(PK)",
              },
            })),
          }),
        );
        return delivery;
      } catch (error) {
        // Covers a competing insert and an ambiguous successful response without a second write.
        const winner = await get(delivery.deliveryId);
        if (winner) return sameNotification(winner, delivery);
        const failure = (typeof error === "object" && error !== null ? error : {}) as {
          name?: string;
          CancellationReasons?: { Code?: string }[];
        };
        const conditional =
          failure.name === "ConditionalCheckFailedException" ||
          failure.CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed");
        throw new JawStackRuntimeError(
          conditional ? "resource.conflict" : "runtime.unavailable",
          "Notification transaction did not complete.",
        );
      }
    },
  };
}
