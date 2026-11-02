import {
  createWorkflowRuntime,
  JawStackDefinitionError,
  type WorkflowDefinition,
  type WorkflowRuntime,
  type WorkflowRuntimeOptions,
} from "@jawstack/core";
import type { DynamoDbClientLike } from "../index";
import { createDynamoWorkflowStorage, reserveWorkflowTable } from "./storage";

export type DynamoWorkflowOptions = WorkflowRuntimeOptions &
  Readonly<{
    client: DynamoDbClientLike;
    tableName: string;
  }>;

export function createDynamoWorkflow(
  definition: WorkflowDefinition,
  options: DynamoWorkflowOptions,
): WorkflowRuntime {
  const { client, tableName, ...runtimeOptions } = options;
  if (
    !client ||
    typeof client.send !== "function" ||
    typeof tableName !== "string" ||
    !/^[A-Za-z0-9_.-]{3,255}$/.test(tableName)
  )
    throw new JawStackDefinitionError(
      "workflow.dynamo",
      "An explicit DynamoDB client and table name are required.",
    );
  let release: (() => void) | undefined;
  try {
    return createWorkflowRuntime(
      definition,
      (spec) => {
        release = reserveWorkflowTable(client, tableName, spec.manifest.hash);
        return createDynamoWorkflowStorage(spec, client, tableName);
      },
      runtimeOptions,
    );
  } catch (error) {
    release?.();
    throw error;
  }
}
