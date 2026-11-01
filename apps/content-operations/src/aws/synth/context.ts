import { isIP } from "node:net";
import { createLabConfig } from "../../lab/config";
import { consumerSchema } from "../../application/failure-records";
import { jobNameSchema } from "../../application/job-store";

export type SynthEntrypoint = "api" | "worker" | "collector" | "scheduler" | "outbox";
export function synthesisContext(entry: SynthEntrypoint, env: NodeJS.ProcessEnv = process.env) {
  const base = createLabConfig(env.CONTENT_OPS_LAB_ID ?? "", "lambda");
  const prefix = "content-operations-local";
  const consumer =
    entry === "worker" || entry === "collector"
      ? consumerSchema.parse(env.CONTENT_OPS_CONSUMER)
      : undefined;
  const job = entry === "scheduler" ? jobNameSchema.parse(env.JAWSTACK_SCHEDULE_NAME) : undefined;
  const expectedNames =
    entry === "outbox"
      ? [`${prefix}-outbox-dispatcher`, `${prefix}-outbox-sweeper`]
      : [
          entry === "api"
            ? `${prefix}-api`
            : entry === "scheduler"
              ? `${prefix}-${job!.toLowerCase()}-scheduler`
              : `${prefix}-${consumer!.toLowerCase()}-${entry}`,
        ];
  const host = env.LOCALSTACK_HOSTNAME ?? "";
  const parts = host.split(".").map(Number);
  const localMetadata =
    isIP(host) === 4 &&
    (parts[0] === 10 ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 192 && parts[1] === 168)) &&
    env.AWS_ENDPOINT_URL === `http://${host}:4566`;
  if (
    env.CONTENT_OPS_STAGE !== "local" ||
    env.JAWSTACK_STAGE !== "local" ||
    env.CONTENT_OPS_RUNTIME !== "localstack" ||
    env.CONTENT_OPS_SYNTH_ONLY !== "true" ||
    env.JAWSTACK_AUTH_MODE !== "dev" ||
    env.JAWSTACK_AUTH_PROVIDER !== "fixtures" ||
    env.AWS_REGION !== base.region ||
    !localMetadata ||
    !expectedNames.includes(env.AWS_LAMBDA_FUNCTION_NAME ?? "") ||
    env.JAWSTACK_TABLE_NAME !== `${prefix}-resources` ||
    env.JAWSTACK_EVENT_BUS_NAME !== `${prefix}-events` ||
    env.CONTENT_OPS_BUCKET_NAME !== base.bucket ||
    env.CONTENT_OPS_EVENT_SOURCE !== base.source ||
    Object.keys(env).some((key) => key.startsWith("AWS_ENDPOINT_URL_") && env[key])
  )
    throw new Error(
      "Synthesis entrypoints require the declared local emulator context and dev fixtures; real AWS execution is disabled.",
    );
  const queueArn = consumer
    ? `arn:aws:sqs:${base.region}:000000000000:${prefix}-${consumer.toLowerCase()}-${entry === "collector" ? "dlq" : "queue"}`
    : undefined;
  if (queueArn && env.CONTENT_OPS_QUEUE_ARN !== queueArn)
    throw new Error("Unexpected synthesis consumer queue.");
  return {
    config: { ...base, table: env.JAWSTACK_TABLE_NAME, bus: env.JAWSTACK_EVENT_BUS_NAME },
    consumer,
    job,
    queueArn,
  };
}
