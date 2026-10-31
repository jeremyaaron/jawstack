import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv, promisify } from "node:util";
import {
  assertCleanAwsEnvironment,
  createLabConfig,
  LabError,
  localstackImage,
  manifestSchema,
  selectRuntime,
  type LabManifest,
} from "../src/lab/config";
import { createClients, destroyClients } from "../src/lab/clients";
import { cleanupSpine, provisionSpine, waitFor } from "../src/lab/provision";
import { verifySpine } from "../src/lab/verify";
import { verifyPaging } from "../src/lab/verify-paging";
import { verifyScopedTransactions } from "../src/lab/verify-transactions";
import { verifyAssets } from "../src/lab/verify-assets";
import { verifyPublication } from "../src/lab/verify-publication";
import { verifyJobs } from "../src/lab/verify-jobs";
import { verifyCapabilities, verifySentinelReset } from "../src/lab/verify-capabilities";
import { buildLab } from "./build-lab";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

async function readSettings(): Promise<NodeJS.ProcessEnv> {
  let file: NodeJS.ProcessEnv = {};
  try {
    file = parseEnv(await readFile(join(root, ".env.localstack"), "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  for (const key of Object.keys(file)) {
    if (
      !["LOCALSTACK_AUTH_TOKEN", "CONTENT_OPS_LOCALSTACK_PLAN", "CONTENT_OPS_LAB_ID"].includes(key)
    )
      throw new LabError("The local token file contains an unsupported setting.");
  }
  return { ...file, ...process.env };
}

async function main() {
  assertCleanAwsEnvironment(process.env);
  const env = await readSettings();
  if (selectRuntime(env.CONTENT_OPS_RUNTIME ?? "localstack") !== "localstack")
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
    throw new LabError("This operation resets the owned proof dataset. Pass --confirm-reset.");
  const config = createLabConfig(env.CONTENT_OPS_LAB_ID ?? "dev");
  const statePath = join(root, ".localstack", `${config.instanceId}.json`);
  let manifest: LabManifest;
  try {
    manifest = manifestSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw new LabError("Invalid lab manifest; refusing to operate or overwrite it.");
    if (command !== "up") throw new LabError("No owned lab manifest. Run local:up first.");
    manifest = {
      schemaVersion: 1,
      instanceId: config.instanceId,
      ownerId: randomUUID(),
      image: localstackImage,
      status: "starting",
      architecture: process.arch === "arm64" ? "arm64" : "x86_64",
      mappings: [],
    };
  }
  if (manifest.instanceId !== config.instanceId)
    throw new LabError("Lab manifest instance mismatch.");
  const save = async () => {
    await mkdir(join(root, ".localstack"), { recursive: true });
    const temp = `${statePath}.tmp`;
    await writeFile(temp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await rename(temp, statePath);
  };
  const dockerEnv = Object.fromEntries(
    Object.entries({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DOCKER_HOST: process.env.DOCKER_HOST,
      DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
      TMPDIR: process.env.TMPDIR,
      LOCALSTACK_AUTH_TOKEN: env.LOCALSTACK_AUTH_TOKEN ?? "not-needed-for-down",
      CONTENT_OPS_PROJECT: config.project,
      CONTENT_OPS_OWNER_ID: manifest.ownerId,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const docker = async (args: string[], timeout = 120_000) => {
    try {
      return (
        await exec("docker", args, {
          cwd: root,
          env: dockerEnv,
          timeout,
          maxBuffer: 2 * 1024 * 1024,
        })
      ).stdout.trim();
    } catch {
      throw new LabError(
        "Docker command failed or timed out. Check the container runtime and local image; no command output is printed because it may contain secrets.",
      );
    }
  };
  const assertContainerOwner = async () => {
    const ids = await docker([
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${config.project}`,
    ]);
    const containers = ids.split(/\s+/).filter(Boolean);
    for (const id of containers) {
      const owner = await docker([
        "inspect",
        "--format",
        '{{index .Config.Labels "jawstack.owner"}}',
        id,
      ]);
      if (owner !== manifest.ownerId)
        throw new LabError("Compose project contains a container not owned by this manifest.");
      const image = await docker(["inspect", "--format", "{{.Config.Image}}", id]);
      if (image !== localstackImage)
        throw new LabError("The owned container is not using the pinned image.");
    }
    return containers.length;
  };
  const compose = (args: string[]) =>
    docker(["compose", "--project-name", config.project, "--file", "compose.yaml", ...args]);
  const containerCount = await assertContainerOwner();
  const noLambdaContainers = () =>
    waitFor("owned Lambda container cleanup", async () =>
      (await docker(["ps", "-aq", "--filter", `name=^/${config.project}-localstack-1-lambda-`])) ===
      ""
        ? true
        : undefined,
    );
  if (command !== "up" && command !== "down" && containerCount !== 1)
    throw new LabError("No unique owned emulator container; run local:up first.");
  const ready = () =>
    waitFor("LocalStack readiness", async () => {
      try {
        const response = await fetch(`${config.endpoint}/_localstack/health`, {
          signal: AbortSignal.timeout(2_000),
          redirect: "error",
        });
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    });
  if (command === "up") {
    if (!env.LOCALSTACK_AUTH_TOKEN?.trim())
      throw new LabError(
        "Set LOCALSTACK_AUTH_TOKEN in .env.localstack; never paste it into chat or Git.",
      );
    if (env.CONTENT_OPS_LOCALSTACK_PLAN !== "hobby")
      throw new LabError(
        "Confirm Hobby (not trial) using CONTENT_OPS_LOCALSTACK_PLAN=hobby in .env.localstack.",
      );
    await save();
    await compose(["up", "--detach", "--wait"]);
    await ready();
    const image = await docker([
      "image",
      "inspect",
      localstackImage,
      "--format",
      "{{json .RepoDigests}}",
    ]);
    console.log(
      JSON.stringify(
        {
          status: "ready",
          endpoint: config.endpoint,
          project: config.project,
          architecture: manifest.architecture,
          imageDigests: JSON.parse(image),
          entitlement: "Hobby (user attested)",
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "down") {
    // The entire owned emulator is ephemeral; stopping it also removes its local service state.
    await compose(["down", "--remove-orphans", "--timeout", "30"]);
    await noLambdaContainers();
    await rm(statePath, { force: true });
    console.log("Owned lab stopped. Ephemeral service state is discarded; images are retained.");
    return;
  }
  await ready();
  const clients = createClients(config);
  const reset = async () => {
    await cleanupSpine(clients, config, manifest);
    await noLambdaContainers();
    manifest = { ...manifest, status: "starting", mappings: [] };
    delete manifest.queueUrl;
    delete manifest.streamArn;
    delete manifest.capabilitiesVersion;
    await save();
  };
  try {
    if (command === "provision") {
      await buildLab();
      await provisionSpine(clients, config, manifest, save);
      console.log("Owned spine resources provisioned.");
    } else if (command === "reset") {
      await reset();
      console.log(
        "Owned service resources removed; emulator remains running. Run local:provision to recreate them.",
      );
    } else {
      if (manifest.status !== "ready") throw new LabError("The lab is not provisioned.");
      if (manifest.capabilitiesVersion !== 1)
        throw new LabError("Reset/reprovision the lab for Phase 1 capabilities first.");
      if (env.CONTENT_OPS_LOCALSTACK_PLAN !== "hobby")
        throw new LabError("Hobby entitlement attestation is required for verification.");
      const started = Date.now();
      const evidence: Record<string, unknown> = {
        status: "running",
        scenario: "feasibility-paging-transactions-assets-publication-and-jobs",
        recordedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        image: manifest.image,
        architecture: manifest.architecture,
        entitlement: "Hobby (user attested)",
      };
      const writeEvidence = () =>
        writeFile(
          join(root, ".localstack", `${config.instanceId}-evidence.json`),
          JSON.stringify(evidence, null, 2),
        );
      await writeEvidence();
      try {
        console.log("Checking transactional spine and worker S3 output...");
        evidence.proof = await verifySpine(clients, config);
        console.log("Checking multi-page DynamoDB queries and transactional projection moves...");
        evidence.paging = await verifyPaging(clients, config);
        console.log(
          "Checking scoped command replay, expiry, atomic rollback, and projection moves...",
        );
        evidence.scopedTransactions = await verifyScopedTransactions(clients, config);
        console.log(
          "Checking immutable asset uploads, readback, interrupted completion, and lifecycle...",
        );
        evidence.assets = await verifyAssets(clients, config);
        console.log("Checking recoverable publication claims and immutable artifacts...");
        evidence.publication = await verifyPublication(clients, config);
        console.log(
          "Checking leased due jobs, reminders, expiry, and conditional orphan cleanup...",
        );
        evidence.jobs = await verifyJobs(clients, config);
        console.log("Waiting for automatic Scheduler and actual SQS redrive/collector...");
        evidence.capabilities = await verifyCapabilities(clients, config);
        console.log("Checking ownership-safe reset with an unrelated-resource sentinel...");
        evidence.cleanup = {
          ...(await verifySentinelReset(clients, config, manifest.ownerId, reset)),
          lambdaContainersAfterReset: 0,
        };
        await provisionSpine(clients, config, manifest, save);
        evidence.reprovisionProof = await verifySpine(clients, config);
        evidence.status = "passed";
        evidence.decision = "go";
        evidence.durationMs = Date.now() - started;
      } catch (error) {
        evidence.status = "failed";
        evidence.decision = "no-go";
        evidence.error =
          error instanceof LabError
            ? error.message
            : error instanceof Error
              ? error.name
              : "unknown";
        throw error;
      } finally {
        evidence.durationMs = Date.now() - started;
        evidence.completedAt = new Date().toISOString();
        await writeEvidence();
      }
      console.log(JSON.stringify(evidence, null, 2));
    }
  } finally {
    destroyClients(clients);
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
