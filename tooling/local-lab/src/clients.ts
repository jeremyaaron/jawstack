import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { IAMClient } from "@aws-sdk/client-iam";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { SQSClient } from "@aws-sdk/client-sqs";
import { S3Client } from "@aws-sdk/client-s3";
import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { createLabTransport } from "./transport";
const failures = new WeakMap<object, Readonly<{ client: string; command: string }>>();
export const requestFailure = (error: unknown) =>
  error && typeof error === "object" ? failures.get(error) : undefined;
const probe =
  <Input, Output>(
    next: (args: Input) => Promise<Output>,
    context: { clientName?: string; commandName?: string },
  ) =>
  async (args: Input): Promise<Output> => {
    try {
      return await next(args);
    } catch (error) {
      if (error && typeof error === "object")
        failures.set(error, {
          client: context.clientName ?? "SDKClient",
          command: context.commandName ?? "Command",
        });
      throw error;
    }
  };

export function createClients() {
  const options = createLabTransport();
  const clients = {
    dynamo: new DynamoDBClient(options),
    events: new EventBridgeClient(options),
    iam: new IAMClient(options),
    lambda: new LambdaClient(options),
    logs: new CloudWatchLogsClient(options),
    sqs: new SQSClient({ ...options, useQueueUrlAsEndpoint: false }),
    s3: new S3Client({ ...options, forcePathStyle: true, followRegionRedirects: false }),
    scheduler: new SchedulerClient(options),
  };
  const telemetry = { step: "initialize" as const, name: "localLabFailureContext" };
  clients.dynamo.middlewareStack.add(probe, telemetry);
  clients.events.middlewareStack.add(probe, telemetry);
  clients.iam.middlewareStack.add(probe, telemetry);
  clients.lambda.middlewareStack.add(probe, telemetry);
  clients.logs.middlewareStack.add(probe, telemetry);
  clients.sqs.middlewareStack.add(probe, telemetry);
  clients.s3.middlewareStack.add(probe, telemetry);
  clients.scheduler.middlewareStack.add(probe, telemetry);
  return clients;
}
export type LabClients = ReturnType<typeof createClients>;
export function destroyClients(clients: LabClients) {
  for (const c of Object.values(clients)) c.destroy();
}
