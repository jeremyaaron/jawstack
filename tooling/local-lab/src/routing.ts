import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { LabError, type LabManifest } from "./config";
import { arn, serviceContext } from "./service-plan";

export async function removeRouting(path: string, manifest: LabManifest) {
  try {
    if ((await stat(path)).size > 64 * 1024)
      throw new LabError("Invalid routing file; refusing removal.");
    const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (
      manifest.schemaVersion !== 2 ||
      value.kind !== "lab-services" ||
      value.schemaVersion !== 1 ||
      value.ownerId !== manifest.ownerId ||
      value.profileHash !== manifest.profileHash ||
      value.project !== manifest.profile.project
    )
      throw new LabError("Foreign routing identity; refusing removal.");
    await rm(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
export async function writeRouting(path: string, manifest: LabManifest) {
  const { profile, plan } = serviceContext(manifest);
  if (manifest.status !== "ready")
    throw new LabError("Routing can only be emitted for a verified ready lab.");
  await removeRouting(path, manifest);
  const temp = `${path}.${randomUUID()}.tmp`;
  const data = {
    schemaVersion: 1,
    kind: "lab-services",
    ownerId: manifest.ownerId,
    profileHash: manifest.schemaVersion === 2 ? manifest.profileHash : "",
    project: profile.project,
    instanceId: profile.instanceId,
    region: "us-east-1",
    accountId: "000000000000",
    tables: plan.tables.map((t) => ({ name: t.name, arn: arn("table", t.name) })),
    buses: plan.buses.map((b) => ({ name: b.name, arn: arn("bus", b.name) })),
    functions: plan.functions.map((f) => ({ name: f.name, arn: arn("function", f.name) })),
    queues: plan.queues.map((q) => ({ name: q.name, arn: arn("queue", q.name) })),
    buckets: plan.buckets.map((b) => b.name),
    scheduleGroups: plan.scheduleGroups.map((g) => g.name),
  };
  try {
    await writeFile(temp, JSON.stringify(data, null, 2), { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
