import type { ResourceRepository, QueryRepository } from "@jawstack/core";
import { createMemoryRuntime } from "./runtime";
import type { createContentDispatch } from "./dispatch";
import type { createUploadService } from "./uploads";
import type { AssetObjectStore } from "./object-store";
import type { PublicationObjectStore } from "./publication-artifact";

export interface ApiRuntime {
  kind: "memory" | "localstack";
  repository: ResourceRepository & QueryRepository;
  dispatch: ReturnType<typeof createContentDispatch>;
  upload: ReturnType<typeof createUploadService>;
  objects: AssetObjectStore & PublicationObjectStore;
  clock: () => Date;
  process?: () => Promise<unknown>;
  tick?: () => Promise<void>;
  close?: () => void | Promise<void>;
}
export function createMemoryApiRuntime(options: { clock?: () => Date } = {}) {
  const clock = options.clock ?? (() => new Date());
  const app = createMemoryRuntime({ clock });
  let nextJobsAt = 0;
  const runtime: ApiRuntime = {
    kind: "memory",
    repository: app.persistence.repository,
    dispatch: app.dispatch,
    upload: app.upload,
    objects: app.objects,
    clock,
    process: app.drainUntilIdle,
    close: app.close,
    tick: async () => {
      if (clock().getTime() >= nextJobsAt) {
        nextJobsAt = clock().getTime() + 60_000;
        for (const name of [
          "duePublication",
          "dueReview",
          "expireUploads",
          "cleanupOrphans",
        ] as const)
          await app.jobs.tick(name);
      }
      await app.pump.drain();
    },
  };
  return { ...runtime, app };
}
export async function createApiRuntime(options: {
  runtime: "memory" | "localstack";
  labId?: string;
  clock?: () => Date;
}): Promise<ApiRuntime> {
  if (options.runtime === "memory") return createMemoryApiRuntime(options);
  if (options.runtime !== "localstack") throw new Error("Select memory or localstack explicitly.");
  const { createLocalstackApiRuntime } = await import("../aws/api-runtime");
  return createLocalstackApiRuntime({
    ...(options.labId ? { labId: options.labId } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
}
