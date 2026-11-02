import { join } from "node:path";
import { archiveIdentity, parseProfile } from "@jawstack/local-lab";
import { applicationProfile } from "../src/aws/profile";
import { labFunctions, type LabConfig } from "../src/lab/config";

// Transitional data registration; service providers/reset stay app-owned until Phase 9.
export async function contentLabProfile(root: string, config: LabConfig) {
  const app = applicationProfile(config);
  const archives = Object.fromEntries(
    await Promise.all(
      ["spine", "publication", "jobs", "recovery"].map(
        async (name) => [name, await archiveIdentity(join(root, "dist", `${name}.zip`))] as const,
      ),
    ),
  );
  return parseProfile({
    schemaVersion: 1,
    instanceId: config.instanceId,
    project: config.project,
    functions: [
      ...labFunctions(config).map((fn) => ({
        name: fn.name,
        handler: fn.handler,
        archive: archives.spine,
      })),
      ...app.functions.map((fn) => ({
        name: fn.name,
        handler: fn.handler,
        archive: archives[fn.bundle],
      })),
    ],
    resources: {
      tables: [config.table],
      buses: [config.bus],
      queues: [
        config.queue,
        config.dlq,
        app.schedulerDlq,
        ...app.workers.flatMap((w) => [w.queue, w.dlq]),
      ],
      roles: [
        config.role,
        config.schedulerRole,
        app.schedulerRole,
        ...app.functions.map((fn) => fn.name),
      ],
      buckets: [config.bucket],
      scheduleGroups: [config.scheduleGroup],
    },
  });
}
