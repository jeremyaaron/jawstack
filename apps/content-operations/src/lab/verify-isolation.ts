import { NodeHttpHandler } from "@smithy/node-http-handler";
import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import { createClients, destroyClients } from "./clients";
import { createLabConfig, LabError } from "./config";
import { createLocalS3ObjectStore } from "../aws/object-store";
import { createApiRuntime } from "../application/api-runtime";

export async function verifyIsolation() {
  const original = NodeHttpHandler.prototype.handle;
  let networkRequests = 0;
  NodeHttpHandler.prototype.handle = () => {
    networkRequests++;
    throw new Error("Unexpected network request in isolation probe.");
  };
  let rejected = 0;
  const reject = async (invoke: () => unknown | Promise<unknown>) => {
    let failed = false;
    try {
      await invoke();
    } catch {
      failed = true;
    }
    if (!failed) throw new LabError("Isolation probe accepted unsafe configuration.");
    rejected++;
  };
  try {
    const config = createLabConfig();
    for (const endpoint of [
      "https://dynamodb.us-east-1.amazonaws.com",
      "http://169.254.169.254:4566",
      "http://127.0.0.1:4566/redirect",
    ]) {
      await reject(() =>
        createClients({ ...config, endpoint: endpoint as typeof config.endpoint }),
      );
      await reject(() => createLocalS3ObjectStore({ ...config, endpoint }));
    }
    for (const key of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_PROFILE",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "AWS_SHARED_CREDENTIALS_FILE",
      "AWS_ENDPOINT_URL",
    ]) {
      const previous = process.env[key];
      process.env[key] = "verification-forbidden-setting";
      try {
        await reject(() => createClients(config));
        await reject(() => createApiRuntime({ runtime: "localstack" }));
      } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }
    await reject(() => createApiRuntime({ runtime: "aws" as "localstack" }));
    const clients = createClients(config);
    try {
      clients.dynamo.middlewareStack.add(
        (next) => async (args) => {
          (args.request as { hostname: string }).hostname = "dynamodb.us-east-1.amazonaws.com";
          return next(args);
        },
        { step: "finalizeRequest", name: "verificationUnsafeDestination", priority: "low" },
      );
      await reject(() =>
        clients.dynamo.send(
          new GetItemCommand({
            TableName: config.table,
            Key: { PK: { S: "never-sent" }, SK: { S: "never-sent" } },
          }),
        ),
      );
    } finally {
      destroyClients(clients);
    }
    if (networkRequests !== 0) throw new LabError("Isolation probe reached network transport.");
    return { rejectedConfigurations: rejected, networkRequests, credentialsLoaded: false };
  } finally {
    NodeHttpHandler.prototype.handle = original;
  }
}
