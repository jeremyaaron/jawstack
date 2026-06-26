import {
  DynamoDbOutboxDispatcher,
  DynamoDbOutboxSweeper,
  type DynamoDbStreamEvent,
} from "@jawstack/aws-runtime";

import { requireEnv } from "./env";
import { createEventBridgePublisher, dynamoDbClientForRuntime } from "./runtime";

const tableName = requireEnv("JAWSTACK_TABLE_NAME");

const dispatcherAdapter = new DynamoDbOutboxDispatcher({
  dynamoDbClient: dynamoDbClientForRuntime(),
  tableName,
  publisher: createEventBridgePublisher(),
});

const sweeperAdapter = new DynamoDbOutboxSweeper({
  dynamoDbClient: dynamoDbClientForRuntime(),
  tableName,
  publisher: createEventBridgePublisher(),
});

export async function dispatcher(event: unknown): Promise<unknown> {
  return dispatcherAdapter.dispatchStream(event as DynamoDbStreamEvent);
}

export async function sweeper(): Promise<unknown> {
  return sweeperAdapter.sweep();
}
