import { z } from "zod";
import {
  DynamoDbOutboxDispatcher,
  DynamoDbWorkerIdempotencyStore,
  EventBridgePublisher,
  SqsWorkerAdapter,
  createSchedulerTargetAdapter,
  type SchedulerEvent,
  type DynamoDbStreamEvent,
  type SqsEvent,
} from "@jawstack/aws-runtime";
import { createLabConfig } from "../lab/config";
import { createClients, destroyClients } from "../lab/clients";
import { collectFailure, handleProofFact, putRecordOnce } from "../lab/handlers";
import { executeProof } from "../lab/resource";
import { queueArn } from "../lab/capabilities";

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
      handler: async ({ event: fact, messageId }) => {
        const record = event.Records?.find((r) => r.messageId === messageId) as
          | { eventSourceARN?: string; attributes?: { ApproximateReceiveCount?: string } }
          | undefined;
        if (record?.eventSourceARN !== queueArn(config, config.queue))
          throw new Error("Unexpected worker queue.");
        const count = z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .parse(record.attributes?.ApproximateReceiveCount);
        await handleProofFact(clients, config, fact, count);
      },
    }).handle(event);
  } finally {
    destroyClients(clients);
  }
}

export async function collector(event: SqsEvent) {
  const { config, clients } = runtime();
  try {
    const records = event.Records as readonly { eventSourceARN?: string }[] | undefined;
    if (!records?.length || records.some((r) => r.eventSourceARN !== queueArn(config, config.dlq)))
      throw new Error("Unexpected collector queue.");
    return await new SqsWorkerAdapter({
      workerName: "spineFailureCollector",
      idempotencyStore: new DynamoDbWorkerIdempotencyStore({
        client: clients.dynamo,
        tableName: config.table,
      }),
      handler: ({ event: fact }) => collectFailure(clients, config, fact),
    }).handle(event);
  } finally {
    destroyClients(clients);
  }
}

export async function scheduled(event: SchedulerEvent) {
  const { config, clients } = runtime();
  try {
    return await createSchedulerTargetAdapter({
      handlers: {
        spineTick: async (input) => {
          const runId = z.uuid().parse(input.runId);
          const resourceId = `scheduled_${runId}`;
          const result = await executeProof(
            clients,
            config,
            resourceId,
            `scheduled:${runId}`,
            runId,
            { message: "Automatic scheduler proof" },
          );
          if (!result.ok) throw new Error("Scheduled command failed.");
          await putRecordOnce(clients, config, {
            PK: `SCHEDULE#${runId}`,
            SK: "FIRED",
            resourceId,
            runId,
          });
          return { resourceId };
        },
      },
    })(event);
  } finally {
    destroyClients(clients);
  }
}
