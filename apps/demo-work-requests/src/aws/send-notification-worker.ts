import {
  DynamoDbWorkerIdempotencyStore,
  SqsWorkerAdapter,
  type SqsEvent,
} from "@jawstack/aws-runtime";

import { requireEnv } from "./env";
import { dynamoDbClientForRuntime } from "./runtime";

const adapter = new SqsWorkerAdapter({
  workerName: "sendNotification",
  idempotencyStore: new DynamoDbWorkerIdempotencyStore({
    client: dynamoDbClientForRuntime(),
    tableName: requireEnv("JAWSTACK_TABLE_NAME"),
  }),
  handler: () => undefined,
});

export async function handler(event: unknown): Promise<unknown> {
  return adapter.handle(event as SqsEvent);
}
