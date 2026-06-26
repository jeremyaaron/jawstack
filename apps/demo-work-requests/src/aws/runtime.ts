import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { HeaderAuthProvider } from "@jawstack/core";
import {
  DynamoDbCommandUnitOfWork,
  DynamoDbRepository,
  EventBridgePublisher,
  type LambdaHttpAdapterOptions,
} from "@jawstack/aws-runtime";

import { demoAppName, demoCostProfile, demoResources } from "../example";
import { requireEnv } from "./env";

const dynamoDbClient = new DynamoDBClient({});
const eventBridgeClient = new EventBridgeClient({});

export function createAwsRuntimeOptions(): LambdaHttpAdapterOptions {
  const tableName = requireEnv("JAWSTACK_TABLE_NAME");

  return {
    appName: process.env.JAWSTACK_APP_NAME ?? demoAppName,
    stage: process.env.JAWSTACK_STAGE ?? "dev",
    registry: demoResources,
    repository: new DynamoDbRepository({
      client: dynamoDbClient,
      tableName,
    }),
    repositoryFactory: ({ idempotencyScope }) =>
      new DynamoDbRepository({
        client: dynamoDbClient,
        tableName,
        ...(idempotencyScope === undefined ? {} : { idempotencyScope }),
      }),
    unitOfWork: new DynamoDbCommandUnitOfWork({
      client: dynamoDbClient,
      tableName,
    }),
    authProvider: new HeaderAuthProvider(),
    auth: {
      mode: "external",
      provider: process.env.JAWSTACK_AUTH_PROVIDER ?? "header",
    },
    costProfile: demoCostProfile,
    source: `${demoAppName}.${process.env.JAWSTACK_STAGE ?? "dev"}`,
  };
}

export function createEventBridgePublisher(): EventBridgePublisher {
  return new EventBridgePublisher({
    client: eventBridgeClient,
    eventBusName: requireEnv("JAWSTACK_EVENT_BUS_NAME"),
    source: `${demoAppName}.${process.env.JAWSTACK_STAGE ?? "dev"}`,
  });
}

export function dynamoDbClientForRuntime(): DynamoDBClient {
  return dynamoDbClient;
}
