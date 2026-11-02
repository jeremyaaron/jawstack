import {
  DynamoDBClient,
  DescribeTableCommand,
  ListTagsOfResourceCommand,
} from "@aws-sdk/client-dynamodb";
import {
  copyWorkflowJson,
  createWorkflowRuntime,
  getWorkflowManifest,
  JawStackDefinitionError,
  JawStackRuntimeError,
  type WorkflowDefinition,
  type WorkflowRuntime,
  type WorkflowRuntimeOptions,
} from "@jawstack/core";
import { createDynamoWorkflowStorage } from "./workflow/storage";
import {
  parseLocalWorkflowBindings,
  localConfigurationError,
  localExecution,
  localObject,
  type LocalWorkflowExecution,
} from "./local/bindings";
import { createLocalAwsTransport } from "./local/transport";

export {
  parseLocalWorkflowBindings,
  type LocalWorkflowBindings,
  type LocalWorkflowExecution,
  type LocalWorkflowFunction,
} from "./local/bindings";
export { createLocalAwsTransport } from "./local/transport";
export type LocalWorkflowOptions = WorkflowRuntimeOptions &
  Readonly<{
    bindings: unknown;
    profile: Readonly<{ name: string; hash: string }>;
    lab: Readonly<{ id: string; ownerId: string }>;
    execution: LocalWorkflowExecution;
  }>;

export async function createLocalWorkflow(
  definition: WorkflowDefinition,
  options: LocalWorkflowOptions,
): Promise<WorkflowRuntime> {
  const manifest = getWorkflowManifest(definition);
  localObject(options);
  const {
    bindings: input,
    profile: profileInput,
    lab: labInput,
    execution: executionInput,
    ...runtimeOptions
  } = options;
  let profile: LocalWorkflowOptions["profile"], lab: LocalWorkflowOptions["lab"];
  try {
    profile = copyWorkflowJson(profileInput, 1024);
    lab = copyWorkflowJson(labInput, 1024);
    localObject(profile);
    localObject(lab);
  } catch {
    return localConfigurationError();
  }
  const bindings = parseLocalWorkflowBindings(input),
    execution = localExecution(executionInput);
  if (
    bindings.workflow.name !== manifest.name ||
    bindings.workflow.source !== manifest.source ||
    bindings.workflow.hash !== manifest.hash ||
    bindings.profile.name !== profile.name ||
    bindings.profile.hash !== profile.hash ||
    bindings.lab.id !== lab.id ||
    bindings.lab.ownerId !== lab.ownerId ||
    Object.keys(profile).sort().join() !== "hash,name" ||
    Object.keys(lab).sort().join() !== "id,ownerId" ||
    manifest.consumers.length !== bindings.consumers.length ||
    manifest.consumers.some((c) => !bindings.consumers.some((b) => b.consumer === c.name))
  )
    localConfigurationError();
  if (execution.kind === "lambda") {
    const f = bindings.functions.find((f) => f.name === execution.functionName);
    if (
      !f ||
      f.role !== execution.role ||
      f.consumer !== execution.consumer ||
      execution.invokedFunctionArn !==
        `arn:aws:lambda:${bindings.region}:${bindings.accountId}:function:${f.name}`
    )
      localConfigurationError();
  }
  // Reject unknown options/callback shapes before the first client or ownership request.
  if (
    Object.keys(runtimeOptions).some(
      (key) => !["clock", "ids", "validateResult", "authorizeOperations", "bind"].includes(key),
    ) ||
    typeof runtimeOptions.bind !== "function"
  )
    localConfigurationError();
  for (const callback of [
    runtimeOptions.clock,
    runtimeOptions.validateResult,
    runtimeOptions.authorizeOperations,
  ])
    if (callback !== undefined && typeof callback !== "function") localConfigurationError();
  if (
    runtimeOptions.ids !== undefined &&
    Object.entries(localObject(runtimeOptions.ids)).some(
      ([key, value]) =>
        !["eventId", "activityId", "requestId", "correlationId", "resourceId"].includes(key) ||
        typeof value !== "function",
    )
  )
    localConfigurationError();
  if (runtimeOptions.ids) runtimeOptions.ids = { ...runtimeOptions.ids };
  const transport = createLocalAwsTransport({ execution });
  let client: DynamoDBClient | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    client?.destroy();
    transport.requestHandler.destroy();
  };
  try {
    client = new DynamoDBClient(transport);
    const expectedArn = `arn:aws:dynamodb:${bindings.region}:${bindings.accountId}:table/${bindings.tableName}`;
    const described = await client.send(
      new DescribeTableCommand({ TableName: bindings.tableName }),
    );
    const table = described.Table;
    if (
      table?.TableArn !== expectedArn ||
      table.TableName !== bindings.tableName ||
      table.TableStatus !== "ACTIVE" ||
      table.KeySchema?.length !== 2 ||
      !table.KeySchema.some((key) => key.AttributeName === "PK" && key.KeyType === "HASH") ||
      !table.KeySchema.some((key) => key.AttributeName === "SK" && key.KeyType === "RANGE") ||
      !["PK", "SK"].every((key) =>
        table.AttributeDefinitions?.some((a) => a.AttributeName === key && a.AttributeType === "S"),
      )
    )
      localConfigurationError();
    const result = await client.send(new ListTagsOfResourceCommand({ ResourceArn: expectedArn }));
    if (result.NextToken) localConfigurationError();
    const tags = result.Tags ?? [];
    const required = {
      "jawstack:owner": lab.ownerId,
      "jawstack:lab": lab.id,
      "jawstack:workflow": manifest.hash,
      "jawstack:profile": profile.hash,
    };
    for (const [Key, Value] of Object.entries(required))
      if (
        tags.filter((tag) => tag.Key === Key).length !== 1 ||
        !tags.some((tag) => tag.Key === Key && tag.Value === Value)
      )
        localConfigurationError();
    return createWorkflowRuntime(
      definition,
      (spec) => ({
        ...createDynamoWorkflowStorage(spec, client!, bindings.tableName),
        close: dispose,
      }),
      runtimeOptions,
    );
  } catch (error) {
    dispose();
    if (error instanceof JawStackRuntimeError || error instanceof JawStackDefinitionError)
      throw error;
    throw new JawStackRuntimeError(
      "runtime.unavailable",
      "Local workflow ownership verification failed.",
    );
  }
}
