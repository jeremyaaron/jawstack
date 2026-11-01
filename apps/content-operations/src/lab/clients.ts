import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { IAMClient } from "@aws-sdk/client-iam";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { SQSClient } from "@aws-sdk/client-sqs";
import { S3Client } from "@aws-sdk/client-s3";
import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  assertCleanAwsEnvironment,
  hostEndpoint,
  validateEndpoint,
  validateRequest,
  type LabConfig,
} from "./config";

export class LocalOnlyHttpHandler extends NodeHttpHandler {
  constructor(private readonly endpoint: string) {
    super({ connectionTimeout: 1_000, requestTimeout: 5_000, throwOnRequestTimeout: true });
    validateEndpoint(endpoint);
  }

  override handle(
    request: Parameters<NodeHttpHandler["handle"]>[0],
    options?: Parameters<NodeHttpHandler["handle"]>[1],
  ): ReturnType<NodeHttpHandler["handle"]> {
    validateRequest(request, this.endpoint);
    return super.handle(request, options);
  }
}

export function createClients(config: LabConfig) {
  if (config.endpoint === hostEndpoint) assertCleanAwsEnvironment(process.env);
  const options = {
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 2,
    requestHandler: new LocalOnlyHttpHandler(config.endpoint),
  };
  return {
    dynamo: new DynamoDBClient(options),
    events: new EventBridgeClient(options),
    iam: new IAMClient(options),
    lambda: new LambdaClient(options),
    logs: new CloudWatchLogsClient(options),
    sqs: new SQSClient({ ...options, useQueueUrlAsEndpoint: false }),
    s3: new S3Client({ ...options, forcePathStyle: true, followRegionRedirects: false }),
    scheduler: new SchedulerClient(options),
  };
}

export type LabClients = ReturnType<typeof createClients>;

export function destroyClients(clients: LabClients): void {
  for (const client of Object.values(clients)) client.destroy();
}
