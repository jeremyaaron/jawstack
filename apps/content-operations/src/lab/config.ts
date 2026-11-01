import { z } from "zod";
import { applicationProfile } from "../aws/profile";

export const localstackImage =
  "localstack/localstack:2026.10.0@sha256:aa5632e041ca54ff61a0a25e17b1c898b09a1eb7f611bfc05f73ef53b7266872";
export const hostEndpoint = "http://127.0.0.1:4566";
export const workerEndpoint = "http://localstack:4566";
export const region = "us-east-1";

export class LabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabError";
  }
}

export function assertCleanAwsEnvironment(env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(env)) {
    if (!value || !key.startsWith("AWS_")) continue;
    if ((key === "AWS_REGION" || key === "AWS_DEFAULT_REGION") && value === region) continue;
    if (key === "AWS_EC2_METADATA_DISABLED" && value === "true") continue;
    throw new LabError(`Remove inherited ${key} before running the isolated lab.`);
  }
}

export function selectRuntime(value: string | undefined): "memory" | "localstack" {
  if (value !== "memory" && value !== "localstack") {
    throw new LabError("Select an explicit memory or localstack runtime.");
  }
  return value;
}

export type LabConfig = ReturnType<typeof createLabConfig>;

export function createLabConfig(instanceId = "dev", execution: "host" | "lambda" = "host") {
  if (!/^[a-z][a-z0-9-]{0,15}$/.test(instanceId)) {
    throw new LabError(
      "Lab ID must be 1-16 lowercase letters, digits, or hyphens, starting with a letter.",
    );
  }
  const project = `jawstack-content-ops-${instanceId}`;
  return Object.freeze({
    instanceId,
    project,
    endpoint: execution === "host" ? hostEndpoint : workerEndpoint,
    region,
    source: `content-operations.${instanceId}`,
    table: `${project}-state`,
    bus: `${project}-events`,
    queue: `${project}-proof`,
    dlq: `${project}-proof-dlq`,
    bucket: `${project}-artifacts`,
    collector: `${project}-collector`,
    scheduled: `${project}-tick`,
    schedulerRole: `${project}-scheduler`,
    scheduleGroup: `${project}-schedules`,
    schedule: "spine-tick",
    role: `${project}-lambda`,
    dispatcher: `${project}-outbox`,
    worker: `${project}-worker`,
    rule: "spine-proof",
  });
}

export function validateEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LabError("Invalid local endpoint.");
  }
  if (
    ![hostEndpoint, workerEndpoint].includes(url.origin) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new LabError("Only the declared local endpoints are allowed.");
  return url;
}

export function validateRequest(
  request: { protocol: string; hostname: string; port?: number },
  endpoint: string,
): void {
  const allowed = validateEndpoint(endpoint);
  if (
    request.protocol !== allowed.protocol ||
    request.hostname !== allowed.hostname ||
    request.port !== 4566
  ) {
    throw new LabError("Blocked a request outside the declared local endpoint.");
  }
}

export function localQueueUrl(
  value: string,
  config: LabConfig,
  queueName: string = config.queue,
): string {
  const url = new URL(value);
  validateEndpoint(url.origin);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/000000000000\/[a-z0-9-]+$/.test(url.pathname)
  ) {
    throw new LabError("Unsafe queue URL returned by the emulator.");
  }
  if (
    ![
      config.queue,
      config.dlq,
      applicationProfile(config).schedulerDlq,
      ...applicationProfile(config).workers.flatMap((worker) => [worker.queue, worker.dlq]),
    ].some((name) => name === queueName) ||
    url.pathname.split("/").at(-1) !== queueName
  )
    throw new LabError("Unexpected queue name.");
  return `${config.endpoint}${url.pathname}`;
}

export const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: z.string(),
    ownerId: z.uuid(),
    image: z.literal(localstackImage),
    status: z.enum(["starting", "provisioning", "ready"]),
    architecture: z.enum(["arm64", "x86_64"]),
    queueUrl: z.string().optional(),
    streamArn: z.string().optional(),
    mappings: z.array(z.string()).default([]),
    capabilitiesVersion: z.literal(1).optional(),
    applicationVersion: z.literal(1).optional(),
  })
  .strict();
export type LabManifest = z.infer<typeof manifestSchema>;

export function assertOwned(tags: Record<string, string> | undefined, ownerId: string): void {
  if (tags?.["jawstack:owner"] !== ownerId)
    throw new LabError("Refusing to modify a resource not owned by this lab manifest.");
}

export function labFunctions(config: LabConfig) {
  return [
    { name: config.dispatcher, handler: "index.dispatcher", timeout: 30 },
    { name: config.worker, handler: "index.worker", timeout: 5 },
    { name: config.collector, handler: "index.collector", timeout: 5 },
    { name: config.scheduled, handler: "index.scheduled", timeout: 30 },
  ] as const;
}
