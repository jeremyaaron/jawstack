import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openLab } from "@jawstack/local-lab";
import { createClients, destroyClients, requestFailure } from "@jawstack/local-lab/clients";
import { assertCleanAwsEnvironment, createLabConfig, LabError } from "../src/lab/config";
import { verifyScopedTransactions } from "../src/lab/verify-transactions";
import { verifySpine } from "../src/lab/verify";
import { verifyApi } from "../src/lab/verify-api";
import { contentLabProfile } from "./lab-profile";

async function main() {
  assertCleanAwsEnvironment(process.env);
  const id = process.env.CONTENT_OPS_LAB_ID;
  if (!id?.startsWith("phase10"))
    throw new LabError("Select a disposable phase10* lab, never the review lab.");
  const config = createLabConfig(id);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const session = await openLab({
    operation: "inspect",
    statePath: join(root, ".localstack", `${id}.json`),
    expected: { instanceId: id, project: config.project },
    profile: await contentLabProfile(root, config),
  });
  const started = Date.now();
  const evidence: Record<string, unknown> = {
    status: "running",
    recordedAt: new Date().toISOString(),
    scenario: "shared-command-storage-with-single-legacy-delivery-owner",
    image: session.manifest.image,
    architecture: session.manifest.architecture,
    instanceId: id,
  };
  const path = join(root, ".localstack", `${id}-command-evidence.json`);
  const save = async () => {
    await writeFile(`${path}.tmp`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  };
  let failure: unknown;
  try {
    await session.ready();
    if (session.manifest.status !== "ready" || session.manifest.applicationVersion !== 1)
      throw new LabError("Provision the fresh owned Content lab before this check.");
    await save();
    const clients = createClients();
    try {
      console.log("Checking shared scoped commands, immutable receipts and atomic rollback...");
      evidence.commands = await verifyScopedTransactions(clients, config);
      await save();
      console.log("Checking the real stream/bus/worker spine...");
      evidence.spine = await verifySpine(clients, config);
      await save();
      console.log(
        "Checking actual HTTP and existing materializer/publisher/notification Lambdas...",
      );
      evidence.application = await verifyApi(config);
      evidence.ownedRuntimesObserved = (await session.inspect()).runtimes.length;
      if (!evidence.ownedRuntimesObserved) throw new LabError("No owned Lambda runtimes observed.");
    } catch (error) {
      evidence.requestFailure = requestFailure(error);
      throw error;
    } finally {
      destroyClients(clients);
    }
  } catch (error) {
    failure = error;
    evidence.error =
      error instanceof LabError ? error.message : error instanceof Error ? error.name : "unknown";
  } finally {
    try {
      console.log("Removing the proof-owned lab and warm runtimes...");
      evidence.teardown = await session.down();
    } catch (error) {
      failure ??= error;
      evidence.teardown = { status: "failed", manifestRetained: true };
    } finally {
      await session.close();
    }
    evidence.status = failure ? "failed" : "passed";
    evidence.completedAt = new Date().toISOString();
    evidence.durationMs = Date.now() - started;
    await save();
  }
  console.log(JSON.stringify(evidence, null, 2));
  if (failure) process.exitCode = 1;
}
void main().catch((error) => {
  console.error(
    error instanceof LabError
      ? error.message
      : "Command migration proof failed; inspect owned state.",
  );
  process.exitCode = 1;
});
