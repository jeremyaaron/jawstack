import { createLabConfig } from "../lab/config";
import { applicationProfile } from "../aws/profile";
import { createContentOperationsResources } from "../domain/resources";

export function contentInfrastructureConfig(
  options: { stage?: string; runtime?: string; labId?: string } = {},
) {
  if ((options.stage ?? "local") !== "local" || (options.runtime ?? "localstack") !== "localstack")
    throw new Error(
      "Content infrastructure is synthesis-only for local/localstack with dev fixtures.",
    );
  const lab = createLabConfig(options.labId ?? "dev");
  const profile = applicationProfile(lab);
  const resources = createContentOperationsResources().map((resource) =>
    resource.name === "contentItem"
      ? {
          ...resource,
          schedules: profile.schedules.map((job) => ({
            name: job.name,
            targetHandler: job.targetHandler,
            expression: "rate(1 minute)",
            retry: { maxAttempts: 0, maxEventAgeSeconds: 60 },
          })),
        }
      : resource,
  );
  return {
    appName: "content-operations",
    stage: "local",
    runtime: "localstack",
    auth: { mode: "dev" as const, provider: "fixtures" },
    resources,
    lab,
    profile,
    costProfile: {
      lambda: {
        defaultTimeoutSeconds: profile.bounds.timeout,
        maxTimeoutSeconds: profile.bounds.timeout,
        defaultMemoryMb: profile.bounds.memory,
        reservedConcurrency: profile.bounds.concurrency,
      },
      queues: {
        defaultMaxConcurrency: profile.bounds.concurrency,
        maxReceiveCount: profile.bounds.receives,
      },
      scheduler: { maxRetryAttempts: 0, maxEventAgeSeconds: 60 },
      dynamodb: { pointInTimeRecovery: false },
    },
  };
}

export const infrastructureArtifacts = [
  "api",
  "outbox",
  "worker",
  "collector",
  "scheduler",
] as const;
export type InfrastructureArtifact = (typeof infrastructureArtifacts)[number];
