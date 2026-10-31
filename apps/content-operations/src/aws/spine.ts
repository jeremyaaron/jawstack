import { PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import {
  DynamoDbOutboxDispatcher,
  DynamoDbWorkerIdempotencyStore,
  EventBridgePublisher,
  SqsWorkerAdapter,
  type DynamoDbStreamEvent,
  type SqsEvent,
} from "@jawstack/aws-runtime";
import { createLabConfig } from "../lab/config";
import { createClients, destroyClients } from "../lab/clients";

function runtime() {
  const config = createLabConfig(z.string().min(1).parse(process.env.CONTENT_OPS_LAB_ID), "lambda");
  return { config, clients: createClients(config) };
}

export async function dispatcher(event: DynamoDbStreamEvent) {
  const { config, clients } = runtime();
  try {
    return await new DynamoDbOutboxDispatcher({
      dynamoDbClient: clients.dynamo,
      tableName: config.table,
      publisher: new EventBridgePublisher({
        client: clients.events,
        eventBusName: config.bus,
        source: config.source,
      }),
    }).dispatchStream(event);
  } finally {
    destroyClients(clients);
  }
}

export async function worker(event: SqsEvent) {
  const { config, clients } = runtime();
  try {
    return await new SqsWorkerAdapter({
      workerName: "spineProof",
      idempotencyStore: new DynamoDbWorkerIdempotencyStore({
        client: clients.dynamo,
        tableName: config.table,
      }),
      handler: async ({ event: fact }) => {
        if (
          fact.source !== config.source ||
          fact.eventType !== "spineProof.created" ||
          fact.resourceType !== "spineProof"
        ) {
          throw new Error("Unexpected spine proof event.");
        }
        const payload = z
          .object({ message: z.string().min(1).max(100) })
          .strict()
          .parse(fact.payload);
        try {
          await clients.dynamo.send(
            new PutItemCommand({
              TableName: config.table,
              Item: marshall({
                PK: `PROOF#${fact.resourceId}`,
                SK: "RECEIPT",
                eventId: fact.eventId,
                correlationId: fact.correlationId,
                message: payload.message,
              }),
              ConditionExpression: "attribute_not_exists(PK)",
            }),
          );
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException")
            throw error;
        }
      },
    }).handle(event);
  } finally {
    destroyClients(clients);
  }
}
