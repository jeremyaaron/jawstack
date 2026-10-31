import { z } from "zod";
import {
  DynamoDbRepository,
  DynamoDbWorkerIdempotencyStore,
  SqsWorkerAdapter,
  type DynamoDbClientLike,
  type SqsEvent,
} from "@jawstack/aws-runtime";
import { createFailureService } from "../application/failures";
import { createContentWorkers } from "../application/workers";
import { createContentDispatch } from "../application/dispatch";
import { consumerSchema } from "../application/failure-records";
import { createLabConfig } from "../lab/config";
import { createClients, destroyClients } from "../lab/clients";
import { queueArn } from "../lab/capabilities";
import { validatedDeliveryBatch, deliveryQueueName, deliveryMarkerTtlSeconds } from "./delivery";
import { parseContentEvent } from "../shared/events";
import { createDynamoFailureStore } from "./failures";
import { createDynamoPersistence } from "./persistence";
import { createDynamoNotificationSink } from "./notifications";
import type { ContentWorkerName } from "../domain/subscriptions";

type TransportOptions = {
  client: DynamoDbClientLike;
  tableName: string;
  source: string;
  expectedQueueArn: string;
  consumer: ContentWorkerName;
  clock?: () => Date;
};
export function createFailureSqsHandler(
  options: TransportOptions & {
    failures: Pick<ReturnType<typeof createFailureService>, "collect" | "validateCollection">;
  },
) {
  const adapter = new SqsWorkerAdapter({
    workerName: `collectFailure.${options.consumer}`,
    idempotencyStore: new DynamoDbWorkerIdempotencyStore({
      client: options.client,
      tableName: options.tableName,
      ttlSeconds: deliveryMarkerTtlSeconds,
      ...(options.clock ? { clock: options.clock } : {}),
    }),
    handler: async ({ event }) => {
      await options.failures.collect(options.consumer, event);
    },
  });
  return async (event: SqsEvent) => {
    const batch = validatedDeliveryBatch(event, {
      queueArn: options.expectedQueueArn,
      source: options.source,
      consumer: options.consumer,
    });
    for (const record of batch.Records)
      await options.failures.validateCollection(options.consumer, JSON.parse(record.body));
    return adapter.handle(batch);
  };
}
export function createContentWorkerSqsHandler(
  options: TransportOptions & {
    workers: Pick<ReturnType<typeof createContentWorkers>, "handle">;
    recovery: Pick<ReturnType<typeof createFailureService>, "authorize">;
  },
) {
  const adapter = new SqsWorkerAdapter({
    workerName: options.consumer,
    idempotencyStore: new DynamoDbWorkerIdempotencyStore({
      client: options.client,
      tableName: options.tableName,
      ttlSeconds: deliveryMarkerTtlSeconds,
      ...(options.clock ? { clock: options.clock } : {}),
    }),
    handler: async ({ event }) => {
      await options.workers.handle(options.consumer, event);
    },
  });
  return async (event: SqsEvent) => {
    const batch = validatedDeliveryBatch(event, {
      queueArn: options.expectedQueueArn,
      source: options.source,
      consumer: options.consumer,
      allowForeignRecovery: true,
    });
    for (const record of batch.Records) {
      const wire: unknown = JSON.parse(record.body);
      const parsed = parseContentEvent(wire, options.source);
      if (parsed.recovery?.consumer === options.consumer)
        await options.recovery.authorize(options.consumer, wire);
    }
    return adapter.handle(batch);
  };
}
async function execute(event: SqsEvent, collect: boolean) {
  const config = createLabConfig(z.string().min(1).parse(process.env.CONTENT_OPS_LAB_ID), "lambda");
  const consumer = consumerSchema.parse(process.env.CONTENT_OPS_CONSUMER);
  if (!collect && consumer === "publishContent") throw new Error("Use the publication entrypoint.");
  const clients = createClients(config);
  try {
    const repository = new DynamoDbRepository({ client: clients.dynamo, tableName: config.table });
    const dispatch = createContentDispatch({
      persistence: createDynamoPersistence({ client: clients.dynamo, tableName: config.table }),
      source: config.source,
    });
    const failures = createFailureService({
      store: createDynamoFailureStore({
        client: clients.dynamo,
        tableName: config.table,
        source: config.source,
      }),
      repository,
      dispatch,
      source: config.source,
    });
    const transport = {
      client: clients.dynamo,
      tableName: config.table,
      source: config.source,
      expectedQueueArn: queueArn(config, deliveryQueueName(config, consumer, collect)),
      consumer,
    };
    if (collect) return await createFailureSqsHandler({ ...transport, failures })(event);
    return await createContentWorkerSqsHandler({
      ...transport,
      recovery: failures,
      workers: createContentWorkers({
        repository,
        dispatch,
        source: config.source,
        notifications: createDynamoNotificationSink({
          client: clients.dynamo,
          tableName: config.table,
        }),
        recovery: failures,
      }),
    })(event);
  } finally {
    destroyClients(clients);
  }
}
export const collector = (event: SqsEvent) => execute(event, true);
export const worker = (event: SqsEvent) => execute(event, false);
