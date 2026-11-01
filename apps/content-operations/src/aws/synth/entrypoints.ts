import {
  DynamoDbOutboxDispatcher,
  DynamoDbOutboxSweeper,
  EventBridgePublisher,
  createSchedulerTargetAdapter,
  type DynamoDbStreamEvent,
  type SchedulerEvent,
  type SqsEvent,
} from "@jawstack/aws-runtime";
import { createContentWorkerSqsHandler, createFailureSqsHandler } from "../recovery";
import { createPublicationSqsHandler } from "../publication";
import { synthesisContext, type SynthEntrypoint } from "./context";
import { createSynthesisRuntime } from "./runtime";
import { createContentJsonLambdaHandler } from "./api";

export const api = createContentJsonLambdaHandler();
async function execute<T>(
  entry: SynthEntrypoint,
  run: (
    runtime: ReturnType<typeof createSynthesisRuntime>,
    context: ReturnType<typeof synthesisContext>,
  ) => T | Promise<T>,
) {
  const context = synthesisContext(entry);
  const runtime = createSynthesisRuntime(context);
  try {
    return await run(runtime, context);
  } finally {
    runtime.close();
  }
}
export function worker(event: SqsEvent) {
  return execute("worker", async (runtime, context) => {
    const options = {
      client: runtime.clients.dynamo,
      tableName: context.config.table,
      source: context.config.source,
      expectedQueueArn: context.queueArn!,
    };
    return context.consumer === "publishContent"
      ? createPublicationSqsHandler({ ...options, publisher: runtime.publisher })(event)
      : createContentWorkerSqsHandler({
          ...options,
          consumer: context.consumer!,
          workers: runtime.workers,
          recovery: runtime.failures,
        })(event);
  });
}
export function collector(event: SqsEvent) {
  return execute("collector", (runtime, context) =>
    createFailureSqsHandler({
      client: runtime.clients.dynamo,
      tableName: context.config.table,
      source: context.config.source,
      expectedQueueArn: context.queueArn!,
      consumer: context.consumer!,
      failures: runtime.failures,
    })(event),
  );
}
export function scheduled(event: SchedulerEvent) {
  return execute("scheduler", (runtime, context) =>
    createSchedulerTargetAdapter({
      handlers: { [context.job!]: () => runtime.jobs.tick(context.job!) },
    })(event),
  );
}
const publisher = (
  runtime: ReturnType<typeof createSynthesisRuntime>,
  context: ReturnType<typeof synthesisContext>,
) =>
  new EventBridgePublisher({
    client: runtime.clients.events,
    eventBusName: context.config.bus,
    source: context.config.source,
  });
export function dispatcher(event: DynamoDbStreamEvent) {
  return execute("outbox", (runtime, context) =>
    new DynamoDbOutboxDispatcher({
      dynamoDbClient: runtime.clients.dynamo,
      tableName: context.config.table,
      publisher: publisher(runtime, context),
    }).dispatchStream(event),
  );
}
export function sweeper() {
  return execute("outbox", (runtime, context) =>
    new DynamoDbOutboxSweeper({
      dynamoDbClient: runtime.clients.dynamo,
      tableName: context.config.table,
      publisher: publisher(runtime, context),
    }).sweep(),
  );
}
