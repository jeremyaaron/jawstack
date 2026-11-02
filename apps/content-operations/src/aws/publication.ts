import { DynamoDbRepository, type DynamoDbClientLike, type SqsEvent } from "@jawstack/aws-runtime";
import { createContentDispatch } from "../application/dispatch";
import { createPublisher, type PublicationFaultPoint } from "../application/publisher";
import type { ContentEvent } from "../shared/events";
import { localLambdaConfig } from "./local-context";
import { createClients, destroyClients } from "../lab/clients";
import { queueArn } from "../lab/capabilities";
import { createDynamoPersistence } from "./persistence";
import { createLocalS3ObjectStore } from "./object-store";
import { contentSqsHandlers } from "./recovery";
export function createPublicationSqsHandler(options: {
  client: DynamoDbClientLike;
  tableName: string;
  expectedQueueArn: string;
  source: string;
  publisher: ReturnType<typeof createPublisher>;
  clock?: () => Date;
}) {
  return contentSqsHandlers({
    ...options,
    consumer: "publishContent",
    handle: (_name, event) => options.publisher(event),
  }).worker;
}
export async function executePublication(
  event: SqsEvent,
  hooks: {
    before?: (event: ContentEvent) => Promise<void>;
    fault?: (event: ContentEvent, point: PublicationFaultPoint) => Promise<void>;
  } = {},
) {
  const config = localLambdaConfig("publisher");
  const clients = createClients(config);
  let objects: ReturnType<typeof createLocalS3ObjectStore> | undefined;
  try {
    objects = createLocalS3ObjectStore(config, { execution: "lambda" });
    const repository = new DynamoDbRepository({ client: clients.dynamo, tableName: config.table });
    const dispatch = createContentDispatch({
      persistence: createDynamoPersistence({
        client: clients.dynamo,
        tableName: config.table,
        source: config.source,
      }),
      source: config.source,
    });
    return await createPublicationSqsHandler({
      client: clients.dynamo,
      tableName: config.table,
      expectedQueueArn: queueArn(config, `${config.project}-publication`),
      source: config.source,
      publisher: async (fact) => {
        await hooks.before?.(fact);
        return createPublisher({
          repository,
          dispatch,
          objects: objects!,
          ...(hooks.fault ? { fault: (point) => hooks.fault!(fact, point) } : {}),
        })(fact);
      },
    })(event);
  } finally {
    objects?.close();
    destroyClients(clients);
  }
}
export const publisher = (event: SqsEvent) => executePublication(event);
