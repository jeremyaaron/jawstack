import { createDynamoWorkflowStorage, type DynamoDbClientLike } from "@jawstack/aws-runtime";
import { createContentStorageSpec } from "../application/workflow";
export function createDynamoFailureStore(options: {
  client: DynamoDbClientLike;
  tableName: string;
  source: string;
}) {
  return createDynamoWorkflowStorage(
    createContentStorageSpec(options.source),
    options.client,
    options.tableName,
  ).failures;
}
