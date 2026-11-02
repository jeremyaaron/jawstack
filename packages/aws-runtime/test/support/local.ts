import type { WorkflowDefinition } from "@jawstack/core";
import type { LocalWorkflowBindings, LocalWorkflowExecution } from "@jawstack/aws-runtime/local";

export const profile = { name: "documents-local", hash: "b".repeat(64) };
export const lab = { id: "wf-test", ownerId: "10000000-0000-4000-8000-000000000001" };
export function localBindings(definition: WorkflowDefinition): LocalWorkflowBindings {
  const prefix = "jawstack-wf-test";
  return {
    schemaVersion: 1,
    workflow: {
      name: definition.manifest.name,
      source: definition.manifest.source,
      hash: definition.manifest.hash,
    },
    profile: { ...profile },
    lab: { ...lab, project: prefix },
    accountId: "000000000000",
    region: "us-east-1",
    tableName: `${prefix}-state`,
    eventBusName: `${prefix}-events`,
    functions: [
      { name: `${prefix}-api`, role: "api" },
      { name: `${prefix}-dispatcher`, role: "dispatcher" },
      ...definition.manifest.consumers.flatMap((consumer) => [
        {
          name: `${prefix}-${consumer.name.toLowerCase()}-worker`,
          role: "worker" as const,
          consumer: consumer.name,
        },
        {
          name: `${prefix}-${consumer.name.toLowerCase()}-collector`,
          role: "collector" as const,
          consumer: consumer.name,
        },
      ]),
    ],
    consumers: definition.manifest.consumers.map((consumer) => ({
      consumer: consumer.name,
      sourceQueueArn: `arn:aws:sqs:us-east-1:000000000000:${prefix}-${consumer.name.toLowerCase()}`,
      deadLetterQueueArn: `arn:aws:sqs:us-east-1:000000000000:${prefix}-${consumer.name.toLowerCase()}-dlq`,
    })),
  };
}
export function lambdaExecution(
  bindings: LocalWorkflowBindings,
  role: "worker" | "collector" = "worker",
): LocalWorkflowExecution {
  const f = bindings.functions.find((f) => f.role === role)!;
  return {
    kind: "lambda",
    functionName: f.name,
    invokedFunctionArn: `arn:aws:lambda:us-east-1:000000000000:function:${f.name}`,
    role,
    consumer: f.consumer!,
  };
}
export function tableDescription(bindings: LocalWorkflowBindings) {
  return {
    Table: {
      TableName: bindings.tableName,
      TableArn: `arn:aws:dynamodb:us-east-1:000000000000:table/${bindings.tableName}`,
      TableStatus: "ACTIVE",
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
      ],
    },
  };
}
export function tableTags(bindings: LocalWorkflowBindings) {
  return {
    Tags: [
      { Key: "jawstack:owner", Value: bindings.lab.ownerId },
      { Key: "jawstack:lab", Value: bindings.lab.id },
      { Key: "jawstack:workflow", Value: bindings.workflow.hash },
      { Key: "jawstack:profile", Value: bindings.profile.hash },
    ],
  };
}
