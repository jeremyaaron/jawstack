import {
  DynamoDbRepository,
  createDynamoWorkflowStorage,
  createWorkflowSqsHandlers,
  type DynamoDbClientLike,
  type SqsEvent,
} from "@jawstack/aws-runtime";
import { createFailureService } from "../application/failures";
import { createContentWorkers } from "../application/workers";
import { createContentDispatch } from "../application/dispatch";
import { consumerSchema } from "../application/failure-records";
import { contentDeliveryWire } from "../shared/events";
import { createContentStorageSpec } from "../application/workflow";
import { createContentDelivery } from "../application/delivery";
import { localLambdaConfig } from "./local-context";
import { createClients, destroyClients } from "../lab/clients";
import { queueArn } from "../lab/capabilities";
import { deliveryQueueName } from "./delivery";
import { createDynamoFailureStore } from "./failures";
import { createDynamoPersistence } from "./persistence";
import { createDynamoNotificationSink } from "./notifications";
import type { ContentWorkerName } from "../domain/subscriptions";
import type { RecoveryFaultPoint } from "../application/failures";

type TransportOptions = {
  client: DynamoDbClientLike;
  tableName: string;
  source: string;
  expectedQueueArn: string;
  consumer: ContentWorkerName;
  clock?: () => Date;
};
type Recovery = Pick<
  ReturnType<typeof createFailureService>,
  "authorize" | "complete" | "collect" | "validateCollection"
>;
const unavailable = async (): Promise<never> => {
  throw new Error("Recovery is not configured.");
};
export function contentSqsHandlers(
  options: TransportOptions & {
    failures?: Partial<Recovery>;
    handle: Parameters<typeof createContentDelivery>[0]["handle"];
  },
  collect = false,
) {
  const spec = createContentStorageSpec(options.source);
  const storage = createDynamoWorkflowStorage(spec, options.client, options.tableName);
  const bound = createContentDelivery({
    source: options.source,
    markers: storage.markers,
    handle: options.handle,
    ...(options.clock ? { clock: options.clock } : {}),
    failures: {
      authorize: options.failures?.authorize ?? unavailable,
      complete: options.failures?.complete ?? unavailable,
      collect: options.failures?.collect ?? unavailable,
      validateCollection: options.failures?.validateCollection ?? unavailable,
    },
  });
  const sourceQueueArn = collect
    ? options.expectedQueueArn.replace(/-dlq$/, "")
    : options.expectedQueueArn;
  return createWorkflowSqsHandlers({
    runtime: {
      ...bound,
      events: {
        parse: spec.parse,
        fact: spec.fact,
        subscribers: (type) =>
          spec.manifest.consumers.filter((c) => c.eventTypes.includes(type)).map((c) => c.name),
      },
    },
    consumer: options.consumer,
    sourceQueueArn,
    deadLetterQueueArn: collect ? options.expectedQueueArn : sourceQueueArn + "-dlq",
  });
}
export function createFailureSqsHandler(
  options: TransportOptions & {
    failures: Pick<Recovery, "collect" | "validateCollection"> & Partial<Recovery>;
  },
) {
  return contentSqsHandlers({ ...options, handle: unavailable }, true).collector;
}
export function createContentWorkerSqsHandler(
  options: TransportOptions & {
    workers: Pick<ReturnType<typeof createContentWorkers>, "handle"> &
      Partial<Pick<ReturnType<typeof createContentWorkers>, "execute">>;
    recovery: Pick<Recovery, "authorize"> & Partial<Recovery>;
  },
) {
  return contentSqsHandlers({
    ...options,
    failures: options.recovery,
    handle:
      options.workers.execute ??
      ((name, event) => options.workers.handle(name, contentDeliveryWire(event))),
  }).worker;
}
export async function executeRecovery(
  event: SqsEvent,
  collect: boolean,
  hooks: {
    before?: (event: unknown) => Promise<void>;
    fault?: (point: RecoveryFaultPoint) => Promise<void>;
  } = {},
) {
  const config = localLambdaConfig(collect ? "collector" : "worker");
  const consumer = consumerSchema.parse(process.env.CONTENT_OPS_CONSUMER);
  if (!collect && consumer === "publishContent") throw new Error("Use the publication entrypoint.");
  const clients = createClients(config);
  try {
    const repository = new DynamoDbRepository({ client: clients.dynamo, tableName: config.table });
    const dispatch = createContentDispatch({
      persistence: createDynamoPersistence({
        client: clients.dynamo,
        tableName: config.table,
        source: config.source,
      }),
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
      ...(hooks.fault ? { fault: hooks.fault } : {}),
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
      workers: {
        handle: async () => {
          throw new Error("Unbound direct invocation.");
        },
        execute: async (name, fact) => {
          await hooks.before?.(fact);
          return createContentWorkers({
            repository,
            dispatch,
            source: config.source,
            notifications: createDynamoNotificationSink({
              client: clients.dynamo,
              tableName: config.table,
            }),
            recovery: failures,
          }).execute(name, fact);
        },
      },
    })(event);
  } finally {
    destroyClients(clients);
  }
}
export const collector = (event: SqsEvent) => executeRecovery(event, true);
export const worker = (event: SqsEvent) => executeRecovery(event, false);
