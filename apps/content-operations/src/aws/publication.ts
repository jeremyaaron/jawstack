import { z } from "zod";
import {
  DynamoDbRepository,
  DynamoDbWorkerIdempotencyStore,
  SqsWorkerAdapter,
  type DynamoDbClientLike,
  type SqsEvent,
} from "@jawstack/aws-runtime";
import { createContentDispatch } from "../application/dispatch";
import { createPublisher } from "../application/publisher";
import { parseContentEvent } from "../shared/events";
import { validatedDeliveryBatch, deliveryMarkerTtlSeconds } from "./delivery";
import { createLabConfig } from "../lab/config";
import { createClients, destroyClients } from "../lab/clients";
import { queueArn } from "../lab/capabilities";
import { createDynamoPersistence } from "./persistence";
import { createLocalS3ObjectStore } from "./object-store";

export function createPublicationSqsHandler(options: {
  client: DynamoDbClientLike;
  tableName: string;
  expectedQueueArn: string;
  source: string;
  publisher: ReturnType<typeof createPublisher>;
  clock?: () => Date;
}) {
  const adapter = new SqsWorkerAdapter({
    workerName: "publishContent",
    idempotencyStore: new DynamoDbWorkerIdempotencyStore({
      client: options.client,
      tableName: options.tableName,
      ttlSeconds: deliveryMarkerTtlSeconds,
      ...(options.clock ? { clock: options.clock } : {}),
    }),
    ...(options.clock ? { clock: options.clock } : {}),
    handler: async ({ event }) => {
      await options.publisher(parseContentEvent(event, options.source));
    },
  });
  return async (input: SqsEvent) =>
    adapter.handle(
      validatedDeliveryBatch(input, {
        queueArn: options.expectedQueueArn,
        source: options.source,
        consumer: "publishContent",
      }),
    );
}

export async function publisher(event: SqsEvent) {
  const config = createLabConfig(z.string().min(1).parse(process.env.CONTENT_OPS_LAB_ID), "lambda");
  const clients = createClients(config);
  let objects: ReturnType<typeof createLocalS3ObjectStore> | undefined;
  try {
    objects = createLocalS3ObjectStore(config, { execution: "lambda" });
    const repository = new DynamoDbRepository({ client: clients.dynamo, tableName: config.table });
    const dispatch = createContentDispatch({
      persistence: createDynamoPersistence({ client: clients.dynamo, tableName: config.table }),
      source: config.source,
    });
    return await createPublicationSqsHandler({
      client: clients.dynamo,
      tableName: config.table,
      expectedQueueArn: queueArn(config, `${config.project}-publication`),
      source: config.source,
      publisher: createPublisher({ repository, dispatch, objects }),
    })(event);
  } finally {
    objects?.close();
    destroyClients(clients);
  }
}
