import { workRequestResource } from "@jawstack/core";

export const demoAppName = "demo-work-requests";
export const demoStage = "local";
export const demoResources = [workRequestResource] as const;
export const demoWorkRequestResource = workRequestResource;

export const demoCostProfile = {
  lambda: {
    defaultTimeoutSeconds: 12,
    maxTimeoutSeconds: 30,
    defaultMemoryMb: 384,
    reservedConcurrency: 5,
  },
  queues: {
    defaultMaxConcurrency: 2,
    maxReceiveCount: 3,
    requireDlq: true,
  },
  dynamodb: {
    billingMode: "onDemand",
    pointInTimeRecovery: false,
  },
  eventBridge: {
    preventSelfTriggeringLoops: true,
    requireEventSchemaVersion: true,
  },
  scheduler: {
    maxRetryAttempts: 2,
    maxEventAgeSeconds: 3600,
    requireDlq: true,
  },
} as const;
