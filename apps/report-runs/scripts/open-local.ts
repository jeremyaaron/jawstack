import { readFile } from "node:fs/promises";
import { currentManifestSchema, profileHash } from "@jawstack/local-lab";
import { createLocalReport } from "../src/workflow";
import { localBindings, topology } from "../src/local-config";
import { root } from "./build";
export async function openLocal(labId: string) {
  const t = topology(labId);
  const manifest = currentManifestSchema.parse(
    JSON.parse(await readFile(root + ".localstack/" + labId + ".json", "utf8")),
  );
  if (
    manifest.instanceId !== labId ||
    manifest.profile.project !== t.project ||
    manifest.status !== "ready" ||
    profileHash(manifest.profile) !== manifest.profileHash
  )
    throw new Error("A matching ready Report Runs lab is required.");
  const bindings = localBindings({
    labId,
    ownerId: manifest.ownerId,
    profileHash: manifest.profileHash,
  });
  return createLocalReport({
    source: t.source,
    bindings,
    profile: bindings.profile,
    lab: { id: labId, ownerId: manifest.ownerId },
    execution: { kind: "host" },
  });
}
