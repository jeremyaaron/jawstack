import { createDynamoWorkflowStorage, type DynamoDbClientLike } from "@jawstack/aws-runtime";
import type { PersistenceFactory } from "../application/persistence";
import { createContentStorageSpec } from "../application/workflow";

export function createDynamoPersistence(options: {
  client: DynamoDbClientLike;
  tableName: string;
  source?: string;
}): PersistenceFactory {
  return createDynamoWorkflowStorage(
    createContentStorageSpec(options.source),
    options.client,
    options.tableName,
  ).command;
}
