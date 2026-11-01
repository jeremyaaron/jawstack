import { GetItemCommand, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDbClientLike } from "@jawstack/aws-runtime";
import { z } from "zod";
import { consumerSchema } from "../application/failure-records";
import type { ContentEvent } from "../shared/events";
import { SimulatedPublicationCrash } from "../application/publisher";

export const controlSchema = z.strictObject({
  ownerId: z.uuid(),
  runId: z.uuid(),
  contentId: z.uuid(),
  consumer: consumerSchema,
  collector: z.boolean(),
  mode: z.enum(["observe", "transient", "crash", "terminal", "collectorAfterRecord"]),
  remaining: z.number().int().min(0).max(1),
});
export type VerificationControl = z.infer<typeof controlSchema>;
export const controlKey = (
  ownerId: string,
  contentId: string,
  consumer: string,
  collector = false,
) => ({
  PK: `VERIFY#${z.uuid().parse(ownerId)}#${z.uuid().parse(contentId)}`,
  SK: `CONTROL#${collector ? "COLLECTOR" : "WORKER"}#${consumerSchema.parse(consumer)}`,
});
export const receiptPartition = (ownerId: string, runId: string) =>
  `VERIFY#${z.uuid().parse(ownerId)}#${z.uuid().parse(runId)}`;
export function faultApplies(control: VerificationControl, fact: ContentEvent, point: string) {
  if (control.contentId !== fact.resourceId || fact.recovery) return false;
  if (
    fact.eventType.startsWith("contentItem.publication") &&
    (fact.payload as { generation?: number }).generation !== 1
  )
    return false;
  return (
    (point === "before" && ["transient", "terminal"].includes(control.mode)) ||
    (point === "afterObjectWrite" && control.mode === "crash") ||
    (point === "afterRecord" && control.mode === "collectorAfterRecord")
  );
}
export async function verificationHooks(options: {
  client: DynamoDbClientLike;
  table: string;
  ownerId: string;
  consumer: z.infer<typeof consumerSchema>;
  fact: ContentEvent;
  messageId: string;
  receiveCount: number;
  collector: boolean;
}) {
  const key = controlKey(
    options.ownerId,
    options.fact.resourceId,
    options.consumer,
    options.collector,
  );
  const output = (await options.client.send(
    new GetItemCommand({ TableName: options.table, Key: marshall(key), ConsistentRead: true }),
  )) as { Item?: Parameters<typeof unmarshall>[0] };
  if (!output.Item) return undefined;
  const { PK, SK, ...data } = unmarshall(output.Item);
  const control = controlSchema.parse(data);
  if (
    PK !== key.PK ||
    SK !== key.SK ||
    control.ownerId !== options.ownerId ||
    control.contentId !== options.fact.resourceId ||
    control.consumer !== options.consumer ||
    control.collector !== options.collector
  )
    throw new Error("Verification control ownership mismatch.");
  const record = async (point: string) => {
    try {
      await options.client.send(
        new PutItemCommand({
          TableName: options.table,
          Item: marshall({
            PK: receiptPartition(control.ownerId, control.runId),
            SK: `${options.collector ? "collector" : "worker"}#${control.consumer}#${control.contentId}#${options.messageId}#${String(options.receiveCount).padStart(3, "0")}#${point}`,
            consumer: control.consumer,
            contentId: control.contentId,
            eventId: options.fact.eventId,
            originalEventId: options.fact.originalEventId,
            receiveCount: options.receiveCount,
            collector: options.collector,
            point,
            occurredAt: new Date().toISOString(),
          }),
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException")
        throw error;
    }
  };
  await record("received");
  return async (point: string) => {
    if (!faultApplies(control, options.fact, point)) return;
    if (control.mode !== "terminal") {
      try {
        await options.client.send(
          new UpdateItemCommand({
            TableName: options.table,
            Key: marshall(key),
            UpdateExpression: "SET remaining = remaining - :one",
            ConditionExpression: "ownerId = :owner AND runId = :run AND remaining > :zero",
            ExpressionAttributeValues: marshall({
              ":one": 1,
              ":zero": 0,
              ":owner": control.ownerId,
              ":run": control.runId,
            }),
          }),
        );
      } catch (error) {
        if (error instanceof Error && error.name === "ConditionalCheckFailedException") return;
        throw error;
      }
    }
    await record(point);
    throw new SimulatedPublicationCrash();
  };
}
