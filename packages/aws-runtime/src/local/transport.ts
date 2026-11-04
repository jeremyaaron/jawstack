import { isIP } from "node:net";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { JawStackDefinitionError } from "@jawstack/core";
import {
  localConfigurationError,
  localExecution,
  localObject,
  type LocalWorkflowExecution,
} from "./bindings";

const hostEndpoint = "http://127.0.0.1:4566",
  lambdaEndpoint = "http://localstack:4566",
  emulatorCredentialEndpoint = "http://127.0.0.1:9001/2021-04-23/credentials";
function privateAddress(host: string) {
  const parts = host.split(".").map(Number);
  return (
    isIP(host) === 4 &&
    (parts[0] === 10 ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 192 && parts[1] === 168))
  );
}
function environment(execution: LocalWorkflowExecution) {
  const env = process.env;
  const emulatorRuntime =
    execution.kind === "lambda" &&
    env.AWS_LAMBDA_RUNTIME_API === "127.0.0.1:9001" &&
    env.AWS_LAMBDA_FUNCTION_NAME === execution.functionName;
  const rejected: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value || !key.startsWith("AWS_")) continue;
    if (["AWS_REGION", "AWS_DEFAULT_REGION"].includes(key) && value === "us-east-1") continue;
    if (key === "AWS_EC2_METADATA_DISABLED" && value === "true") continue;
    if (execution.kind === "lambda") {
      if (key === "AWS_LAMBDA_FUNCTION_NAME" && value === execution.functionName) continue;
      if (
        key === "AWS_ENDPOINT_URL" &&
        (value === lambdaEndpoint ||
          (privateAddress(env.LOCALSTACK_HOSTNAME ?? "") &&
            value === `http://${env.LOCALSTACK_HOSTNAME}:4566`))
      )
        continue;
      if (
        ["AWS_ACCESS_KEY_ID", "AWS_ACCESS_KEY"].includes(key) &&
        (value === "test" || value === "000000000000" || /^L[SK]IA[A-Z0-9]{16,124}$/.test(value))
      )
        continue;
      // Emulator-injected role credentials are ignored; the SDK always receives test/test.
      if (
        [
          "AWS_SECRET_ACCESS_KEY",
          "AWS_SECRET_KEY",
          "AWS_SESSION_TOKEN",
          "AWS_SECURITY_TOKEN",
        ].includes(key) &&
        /^L[SK]IA[A-Z0-9]{16,124}$/.test(env.AWS_ACCESS_KEY_ID ?? "") &&
        value.length <= 4096
      )
        continue;
      if (key === "AWS_SECRET_ACCESS_KEY" && value === "test") continue;
      if (emulatorRuntime && key === "AWS_LAMBDA_METADATA_API" && value === "127.0.0.1:9001")
        continue;
      if (
        emulatorRuntime &&
        key === "AWS_LAMBDA_METADATA_TOKEN" &&
        /^[\x21-\x7e]{1,4096}$/.test(value)
      )
        continue;
      if (
        emulatorRuntime &&
        env.AWS_CONTAINER_CREDENTIALS_FULL_URI === emulatorCredentialEndpoint &&
        (key === "AWS_CONTAINER_CREDENTIALS_FULL_URI" ||
          (key === "AWS_CONTAINER_AUTHORIZATION_TOKEN" &&
            /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)))
      )
        continue;
      if (key === "AWS_EXECUTION_ENV" && /^AWS_Lambda_nodejs(?:22|24)\.x$/.test(value)) continue;
      if (key === "AWS_EXECUTION_ENV" && value === "AWS_Lambda_rapid" && emulatorRuntime) continue;
      if (key === "AWS_ACCOUNT_ID" && value === "000000000000") continue;
      if (key === "AWS_LAMBDA_FUNCTION_TIMEOUT" && value === "30") continue;
      if (key === "AWS_LAMBDA_FUNCTION_VERSION" && value === "$LATEST") continue;
      if (key === "AWS_LAMBDA_FUNCTION_MEMORY_SIZE" && value === "256") continue;
      if (key === "AWS_LAMBDA_INITIALIZATION_TYPE" && value === "on-demand") continue;
      if (key === "AWS_LAMBDA_LOG_GROUP_NAME" && value === `/aws/lambda/${execution.functionName}`)
        continue;
      if (key === "AWS_LAMBDA_LOG_STREAM_NAME" && /^[A-Za-z0-9/[\]$_.-]{1,256}$/.test(value))
        continue;
      if (key === "AWS_LAMBDA_RUNTIME_API" && /^127\.0\.0\.1:\d{1,5}$/.test(value)) continue;
      if (key === "AWS_XRAY_CONTEXT_MISSING" && value === "LOG_ERROR") continue;
      if (key === "AWS_XRAY_DAEMON_ADDRESS" && value === "127.0.0.1:2000") continue;
    }
    // Diagnose bounded setting names only, never credentials or other environment values.
    const name = /^AWS_[A-Z0-9_]{1,64}$/.test(key) ? key : "unrecognized AWS setting";
    if (rejected.length < 16) rejected.push(name);
  }
  if (rejected.length)
    throw new JawStackDefinitionError(
      "workflow.local",
      `Invalid or unsafe local workflow environment settings: ${rejected.join(", ")}.`,
    );
  if (execution.kind === "lambda" && env.AWS_LAMBDA_FUNCTION_NAME !== execution.functionName)
    localConfigurationError();
}
class LocalOnlyHttpHandler extends NodeHttpHandler {
  constructor(private readonly hostname: string) {
    super({ connectionTimeout: 1000, requestTimeout: 5000, throwOnRequestTimeout: true });
  }
  override handle(
    request: Parameters<NodeHttpHandler["handle"]>[0],
    options?: Parameters<NodeHttpHandler["handle"]>[1],
  ): ReturnType<NodeHttpHandler["handle"]> {
    if (
      request.protocol !== "http:" ||
      request.hostname !== this.hostname ||
      request.port !== 4566 ||
      request.username ||
      request.password ||
      request.headers.host !== `${this.hostname}:4566`
    )
      localConfigurationError();
    return super.handle(request, options);
  }
}
export function createLocalAwsTransport(options: { execution: LocalWorkflowExecution }) {
  localObject(options);
  if (Object.keys(options).length !== 1 || !("execution" in options)) localConfigurationError();
  const execution = localExecution(options.execution);
  environment(execution);
  const hostname = execution.kind === "host" ? "127.0.0.1" : "localstack";
  return Object.freeze({
    endpoint: execution.kind === "host" ? hostEndpoint : lambdaEndpoint,
    region: "us-east-1" as const,
    // The SDK annotates identities with $source; never share a frozen identity object.
    credentials: async () => ({ accessKeyId: "test", secretAccessKey: "test" }),
    maxAttempts: 2,
    requestHandler: new LocalOnlyHttpHandler(hostname),
  });
}
