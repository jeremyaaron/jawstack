import {
  createWorkflowRuntime,
  JawStackDefinitionError,
  type WorkflowDefinition,
  type WorkflowRuntime,
  type WorkflowRuntimeOptions,
} from "@jawstack/core";
import type { DynamoDbClientLike } from "../index";
import { createDynamoWorkflowStorage } from "./storage";

export type DynamoWorkflowOptions = WorkflowRuntimeOptions &
  Readonly<{
    client: DynamoDbClientLike;
    tableName: string;
  }>;
const owners = new WeakMap<object, Map<string, string>>();

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
  let reserved: Map<string, string> | undefined;
  let reservationHash: string | undefined;
  try {
    return createWorkflowRuntime(
      definition,
      (spec) => {
        const tables = owners.get(client) ?? new Map<string, string>();
        const previous = tables.get(tableName);
        if (previous && previous !== spec.manifest.hash)
          throw new JawStackDefinitionError(
            "workflow.dynamo",
            "The client/table is already assigned to a different workflow declaration.",
          );
        tables.set(tableName, spec.manifest.hash);
        owners.set(client, tables);
        if (previous === undefined) {
          reserved = tables;
          reservationHash = spec.manifest.hash;
        }
        return createDynamoWorkflowStorage(spec, client, tableName);
      },
      runtimeOptions,
    );
  } catch (error) {
    if (reserved?.get(tableName) === reservationHash) reserved?.delete(tableName);
    throw error;
  }
}
