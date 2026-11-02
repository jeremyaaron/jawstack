import { fileURLToPath } from "node:url";
import {
  createWorkRequestInput,
  defineSchedule,
  defineWorker,
  defineWorkflow,
  workRequestResource,
  type ResourceDefinition,
} from "@jawstack/core";
import type { JawStackResourceWorkflowAppProps } from "../../src/index";

export const asset = fileURLToPath(new URL("../fixtures/recovery-handler/", import.meta.url));
export function resource(name = "workRequest", workers = ["process"]): ResourceDefinition {
  return {
    ...workRequestResource,
    name,
    workers: workers.map((name) =>
      defineWorker({ name, eventTypes: ["workRequest.created"], maxConcurrency: 2 }),
    ),
    schedules: [defineSchedule({ name: "tick", targetHandler: "tick", expression: "rate(1 day)" })],
  };
}
export function legacyProps(): JawStackResourceWorkflowAppProps {
  return {
    appName: "recovery-test",
    stage: "dev",
    resources: [resource()],
    costProfile: {
      lambda: {
        defaultTimeoutSeconds: 12,
        maxTimeoutSeconds: 30,
        defaultMemoryMb: 384,
        reservedConcurrency: 7,
      },
      queues: { defaultMaxConcurrency: 5, maxReceiveCount: 4 },
    },
    auth: { mode: "external", provider: "header" },
    entrypoints: {
      apiHandler: asset,
      outboxHandler: asset,
      workerHandlers: { process: asset },
      schedulerHandlers: { tick: asset },
    },
  };
}
export function definition(
  resources: readonly ResourceDefinition[],
  policies: Parameters<typeof defineWorkflow>[0]["consumers"] = Object.fromEntries(
    resources.flatMap((r) => r.workers).map((w) => [w.name, { recovery: "replay" as const }]),
  ),
) {
  const events = new Map(
    resources
      .flatMap((r) => Object.values(r.commands).flatMap((c) => c.emits))
      .map((e) => [`${e.eventType}#${e.schemaVersion}`, e]),
  );
  return defineWorkflow({
    name: "recovery-test",
    source: "recovery-test.local",
    resources,
    commands: { idempotencyTtlSeconds: 604800 },
    consumers: policies,
    operations: { resourceType: resources[0]!.name, projection: `${resources[0]!.name}.failures` },
    // Infrastructure-only declarations: no business handler or runtime is executed here.
    events: [...events.values()].map((e) => ({
      ...e,
      schema: createWorkRequestInput,
      validateIdentity: (event) => event.resourceType === resources[0]!.name,
    })),
  });
}
export function managedProps(resources = [resource()]): JawStackResourceWorkflowAppProps {
  const base = legacyProps();
  return {
    ...base,
    resources,
    costProfile: {
      lambda: {
        defaultTimeoutSeconds: 30,
        maxTimeoutSeconds: 30,
        defaultMemoryMb: 256,
        reservedConcurrency: 2,
      },
      queues: { defaultMaxConcurrency: 2, maxReceiveCount: 3 },
    },
    entrypoints: {
      ...base.entrypoints,
      workerHandlers: Object.fromEntries(
        resources.flatMap((r) => r.workers).map((w) => [w.name, asset]),
      ),
    },
    recoverableWorkers: { definition: definition(resources), collectorHandler: asset },
  };
}
