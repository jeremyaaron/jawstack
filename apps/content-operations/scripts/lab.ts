import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openLab, profileHash } from "@jawstack/local-lab";
import {
  assertCleanAwsEnvironment,
  createLabConfig,
  LabError,
  selectRuntime,
  type LabManifest,
} from "../src/lab/config";
import { createClients, destroyClients, requestFailure } from "@jawstack/local-lab/clients";
import { verifySpine } from "../src/lab/verify";
import { verifyApi } from "../src/lab/verify-api";
import { verifyCapabilities, verifySentinelReset } from "../src/lab/verify-capabilities";
import { buildLab, buildVerification } from "./build-lab";
import { inspectRuntimes, runtimeProfile } from "../src/lab/containers";
import { verifyRuntimeCleanup } from "../src/lab/verify-runtime-cleanup";
import { verifyDelivery } from "../src/lab/verify-delivery";
import { verifyIsolation } from "../src/lab/verify-isolation";
import { contentLabProfile } from "./lab-profile";

const root = fileURLToPath(new URL("../", import.meta.url));
async function main() {
  assertCleanAwsEnvironment(process.env);
  if (selectRuntime(process.env.CONTENT_OPS_RUNTIME ?? "localstack") !== "localstack")
    throw new LabError("Lab lifecycle commands require the localstack runtime.");
  const command = process.argv[2];
  if (!["up", "provision", "verify", "reset", "down"].includes(command ?? ""))
    throw new LabError("Expected up, provision, verify, reset, or down.");
  if (
    process.argv
      .slice(3)
      .some((arg) => !["reset", "verify"].includes(command ?? "") || arg !== "--confirm-reset")
  )
    throw new LabError("Unexpected lab command argument.");
  if (["reset", "verify"].includes(command ?? "") && !process.argv.includes("--confirm-reset"))
    throw new LabError(
      "This operation resets the owned application dataset. Pass --confirm-reset.",
    );
  const config = createLabConfig(process.env.CONTENT_OPS_LAB_ID ?? "dev");
  const statePath = join(root, ".localstack", `${config.instanceId}.json`);
  if (command === "up" || command === "provision") await buildLab();
  const profile = command === "down" ? undefined : await contentLabProfile(root, config);
  const session = await openLab({
    statePath,
    expected: { instanceId: config.instanceId, project: config.project },
    operation: command === "up" ? "up" : command === "down" ? "down" : "inspect",
    ...(profile ? { profile } : {}),
    legacy: runtimeProfile(config),
  });
  try {
    let manifest: LabManifest = session.manifest;
    const save = async () => {
      session.manifest = manifest;
      await session.save();
    };
    const shutdown = () => session.down();
    const docker = session.docker;
    if (command === "up") {
      console.log(
        JSON.stringify(
          await session.up({
            tokenFile: join(root, ".env.localstack"),
            planKey: "CONTENT_OPS_LOCALSTACK_PLAN",
            labIdKey: "CONTENT_OPS_LAB_ID",
          }),
          null,
          2,
        ),
      );
      return;
    }
    if (command === "down") {
      console.log(JSON.stringify({ status: "stopped", ...(await shutdown()) }, null, 2));
      return;
    }
    await session.ready();
    const clients = createClients();
    const reset = async () => {
      await session.reset();
      manifest = session.manifest;
    };
    const provision = async () => {
      await session.provision();
      manifest = session.manifest;
      manifest.capabilitiesVersion = 1;
      manifest.applicationVersion = 1;
      manifest.runtimeOwnershipVersion = 1;
      await save();
    };
    try {
      if (command === "provision") {
        if (
          !profile ||
          manifest.schemaVersion !== 2 ||
          profileHash(profile) !== manifest.profileHash
        )
          throw new LabError(
            "Rebuilt application archives differ from the live profile; down/recreate the lab.",
          );
        await provision();
        console.log(
          "Owned application and feasibility spine provisioned; application schedules enabled.",
        );
      } else if (command === "reset") {
        await reset();
        console.log(
          "Owned service resources removed; emulator remains running. Run local:provision to recreate them.",
        );
      } else {
        if (manifest.status !== "ready") throw new LabError("The lab is not provisioned.");
        if (manifest.capabilitiesVersion !== 1)
          throw new LabError("Reset/reprovision the lab for Phase 1 capabilities first.");
        if (manifest.applicationVersion !== 1)
          throw new LabError(
            "Reset/reprovision the lab for the actual application topology first.",
          );
        if (manifest.runtimeOwnershipVersion !== 1)
          throw new LabError(
            "Reset/reprovision with manifest-owner runtime labels before verification.",
          );
        const started = Date.now();
        const evidence: Record<string, unknown> = {
          status: "running",
          scenario: "full-deployed-application-failure-isolation-and-cleanup-gate",
          recordedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          image: manifest.image,
          architecture: manifest.architecture,
          entitlement: "Hobby (user attested)",
        };
        const writeEvidence = async () => {
          const path = join(root, ".localstack", `${config.instanceId}-evidence.json`);
          await writeFile(`${path}.tmp`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
          await rename(`${path}.tmp`, path);
        };
        await writeEvidence();
        let failure: unknown;
        try {
          console.log("Proving unsafe configurations stop before network transport...");
          evidence.isolation = await verifyIsolation();
          console.log("Checking transactional spine and worker S3 output...");
          evidence.proof = await verifySpine(clients, config);
          console.log(
            "Checking actual HTTP/upload/review/Scheduler/publisher/notification Lambdas...",
          );
          evidence.application = await verifyApi(config);
          const runtimes = await inspectRuntimes(docker, config, manifest.ownerId);
          if (!runtimes.length)
            throw new LabError("No ownership-proven application runtimes observed.");
          evidence.ownedRuntimesObserved = runtimes.length;
          await buildVerification();
          console.log(
            "Checking deployed duplicate, retry, crash, DLQ, collector and recovery scenarios...",
          );
          evidence.delivery = await verifyDelivery(clients, config, manifest.ownerId);
          console.log("Waiting for automatic Scheduler and actual SQS redrive/collector...");
          evidence.capabilities = await verifyCapabilities(clients, config);
          console.log("Checking ownership-safe reset with an unrelated-resource sentinel...");
          evidence.cleanup = {
            ...(await verifySentinelReset(
              clients,
              config,
              manifest.ownerId,
              reset,
              () => manifest,
            )),
            lambdaContainersAfterReset: 0,
          };
          await provision();
          evidence.reprovisionProof = await verifySpine(clients, config);
          evidence.reprovisionApplication = await verifyApi(config);
        } catch (error) {
          failure = error;
          evidence.requestFailure = requestFailure(error);
          evidence.error =
            error instanceof LabError
              ? error.message
              : error instanceof Error
                ? error.name
                : "unknown";
        } finally {
          destroyClients(clients);
          try {
            console.log("Checking foreign-lookalike refusal, orphan cleanup and final teardown...");
            evidence.teardown = failure
              ? await shutdown()
              : await verifyRuntimeCleanup(docker, config, manifest.ownerId, shutdown);
          } catch (error) {
            failure ??= error;
            let recovery: unknown;
            try {
              recovery = await shutdown();
            } catch {
              recovery = { status: "failed", manifestRetained: true };
            }
            evidence.teardown = {
              status: "failed",
              recovery,
              error:
                error instanceof LabError ? error.message : "Cleanup failed; inspect owned lab.",
            };
          }
          evidence.status = failure ? "failed" : "passed";
          evidence.decision = failure ? "no-go" : "go";
          evidence.durationMs = Date.now() - started;
          evidence.completedAt = new Date().toISOString();
          await writeEvidence();
        }
        console.log(JSON.stringify(evidence, null, 2));
        if (failure) throw failure;
      }
    } finally {
      destroyClients(clients);
    }
  } finally {
    await session.close();
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof LabError
      ? error.message
      : `Lab operation failed (${error instanceof Error ? error.name : "unknown error"}). No credentials or raw service response printed.`,
  );
  process.exitCode = 1;
});
