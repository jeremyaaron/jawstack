import { createLabConfig, LabError } from "../lab/config";
import { consumerSchema } from "../application/failure-records";
import { applicationProfile } from "./profile";
import { isIP } from "node:net";

function injectedEndpoint(key: string, value: string, env: NodeJS.ProcessEnv) {
  if (key !== "AWS_ENDPOINT_URL") return false;
  if (value === "http://localstack:4566") return true;
  const host = env.LOCALSTACK_HOSTNAME ?? "";
  const parts = host.split(".").map(Number);
  // LocalStack injects its current bridge address. It is metadata, never an SDK destination.
  return (
    isIP(host) === 4 &&
    (parts[0] === 10 ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 192 && parts[1] === 168)) &&
    value === `http://${host}:4566`
  );
}

export function localLambdaConfig(
  entry: "publisher" | "jobs" | "worker" | "collector",
  env: NodeJS.ProcessEnv = process.env,
) {
  const config = createLabConfig(env.CONTENT_OPS_LAB_ID ?? "", "lambda");
  const profile = applicationProfile(config);
  const consumer =
    entry === "worker" || entry === "collector"
      ? consumerSchema.parse(env.CONTENT_OPS_CONSUMER)
      : undefined;
  const worker = profile.workers.find((item) => item.consumer === consumer);
  const expected =
    entry === "publisher"
      ? `${config.project}-publisher`
      : entry === "jobs"
        ? profile.jobs
        : entry === "collector"
          ? worker?.collector
          : worker?.name;
  if (
    !expected ||
    env.AWS_LAMBDA_FUNCTION_NAME !== expected ||
    (entry === "worker" && consumer === "publishContent") ||
    (env.CONTENT_OPS_RUNTIME && env.CONTENT_OPS_RUNTIME !== "localstack") ||
    (env.CONTENT_OPS_STAGE && env.CONTENT_OPS_STAGE !== "local") ||
    Object.keys(env).some(
      (key) =>
        env[key] && key.startsWith("AWS_ENDPOINT_URL") && !injectedEndpoint(key, env[key]!, env),
    )
  )
    throw new LabError("Application Lambda requires its declared local execution context.");
  return config;
}
