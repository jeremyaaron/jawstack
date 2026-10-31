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
import { limits } from "../shared/validation";
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
      ...(options.clock ? { clock: options.clock } : {}),
    }),
    ...(options.clock ? { clock: options.clock } : {}),
    handler: async ({ event }) => {
      await options.publisher(parseContentEvent(event, options.source));
    },
  });
  return async (input: SqsEvent) => {
    // Validate every record before even a cached marker can acknowledge a foreign delivery.
    const batch = z
      .object({
        Records: z
          .array(
            z.object({
              messageId: z.string().min(1).max(128),
              body: z.string().max(limits.eventBytes * 2 + 16384),
              eventSourceARN: z.literal(options.expectedQueueArn),
            }),
          )
          .min(1)
          .max(10),
      })
      .parse(input);
    for (const record of batch.Records) {
      if (Buffer.byteLength(record.body) > limits.eventBytes * 2 + 16384)
        throw new Error("Publication transport byte budget exceeded.");
      const decoded: unknown = JSON.parse(record.body);
      let envelope = decoded;
      if (typeof decoded === "object" && decoded !== null && "detail" in decoded) {
        const outer = decoded as Record<string, unknown>;
        envelope = typeof outer.detail === "string" ? JSON.parse(outer.detail) : outer.detail;
        const inner = parseContentEvent(envelope, options.source);
        if (
          (outer.source !== undefined && outer.source !== options.source) ||
          (outer["detail-type"] !== undefined && outer["detail-type"] !== inner.eventType)
        )
          throw new Error("Publication transport source/type mismatch.");
      }
      const event = parseContentEvent(envelope, options.source);
      if (
        event.eventType !== "contentItem.publicationRequested" &&
        event.eventType !== "contentItem.publicationRetried"
      )
        throw new Error("Unexpected publication fact.");
    }
    return adapter.handle(input);
  };
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
