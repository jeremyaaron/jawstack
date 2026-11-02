import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual, parseEnv, promisify } from "node:util";
import { copyWorkflowJson } from "@jawstack/core";
import { z } from "zod";
import {
  assertCleanAwsEnvironment,
  hostEndpoint,
  LabError,
  localstackImage,
  manifestSchema,
  parseProfile,
  type LabManifest,
  type LabProfile,
  type RuntimeProfile,
} from "./config";
import { cleanupRuntimes, inspectRuntimes, type DockerCommand } from "./containers";
import { waitFor } from "./lifecycle";
import { profileHash, verifyArchives } from "./profile";
import { createLabTransport } from "./transport";

const exec = promisify(execFile);
const idSchema = z.string().regex(/^[a-f0-9]{64}$/);
const inspectedSchema = z.object({
  id: idSchema,
  name: z.string(),
  image: z.string(),
  status: z.string(),
  labels: z.record(z.string(), z.string()).nullable(),
  ports: z.unknown(),
});
const networkSchema = z.object({
  id: idSchema,
  name: z.string(),
  labels: z.record(z.string(), z.string()).nullable(),
  containers: z.record(z.string(), z.unknown()).nullable(),
});
export function createDockerCommand(
  root: string,
  startupEnvironment: Record<string, string> = {},
): DockerCommand {
  const env = Object.fromEntries(
    Object.entries({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DOCKER_HOST: process.env.DOCKER_HOST,
      DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
      TMPDIR: process.env.TMPDIR,
      ...startupEnvironment,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return async (args, timeout = 120_000) => {
    try {
      return (
        await exec("docker", args, { cwd: root, env, timeout, maxBuffer: 2 * 1024 * 1024 })
      ).stdout.trim();
    } catch {
      throw new LabError(
        "Docker command failed or timed out; raw output withheld because it may contain secrets.",
      );
    }
  };
}
function ids(output: string) {
  const values = output.split(/\s+/).filter(Boolean);
  if (values.length > 200 || values.some((id) => !/^[a-f0-9]{12,64}$/.test(id)))
    throw new LabError("Invalid bounded Docker inventory.");
  return [...new Set(values)];
}
function parseManifest(input: unknown): LabManifest {
  try {
    return manifestSchema.parse(copyWorkflowJson(input, 256 * 1024));
  } catch {
    throw new LabError("Invalid lab manifest; refusing to operate or overwrite it.");
  }
}
export function decodeManifest(
  input: unknown,
  expected: { instanceId: string; project: string },
  legacy?: RuntimeProfile,
): LabManifest {
  const manifest = parseManifest(input);
  if (manifest.instanceId !== expected.instanceId)
    throw new LabError("Lab manifest instance mismatch.");
  if (manifest.schemaVersion === 1) {
    if (!legacy || legacy.project !== expected.project || !legacy.functions.length)
      throw new LabError("No exact legacy teardown profile; refusing adoption.");
  } else if (
    manifest.profile.project !== expected.project ||
    manifest.profile.instanceId !== expected.instanceId ||
    profileHash(manifest.profile) !== manifest.profileHash
  ) {
    throw new LabError("Lab manifest profile identity mismatch.");
  }
  if (
    manifest.queueUrl &&
    !["http://127.0.0.1:4566", "http://localstack:4566"].some(
      (origin) =>
        manifest.queueUrl!.startsWith(`${origin}/000000000000/${expected.project}-`) &&
        /^[a-zA-Z0-9-]+$/.test(manifest.queueUrl!.slice(`${origin}/000000000000/`.length)),
    )
  )
    throw new LabError("Invalid manifest queue identity.");
  if (
    manifest.streamArn &&
    !manifest.streamArn.startsWith(
      `arn:aws:dynamodb:us-east-1:000000000000:table/${expected.project}-`,
    )
  )
    throw new LabError("Invalid manifest stream identity.");
  return manifest;
}
async function readManifest(path: string) {
  if ((await stat(path)).size > 256 * 1024)
    throw new LabError("Oversized lab manifest; refusing operation.");
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new LabError("Invalid lab manifest; refusing to operate or overwrite it.");
  }
}
export async function openLab(input: {
  statePath: string;
  expected: { instanceId: string; project: string };
  operation: "up" | "inspect" | "down";
  profile?: LabProfile;
  legacy?: RuntimeProfile;
  docker?: DockerCommand;
}) {
  const options = {
    ...input,
    expected: Object.freeze({ ...input.expected }),
    ...(input.legacy
      ? {
          legacy: Object.freeze({
            project: input.legacy.project,
            functions: Object.freeze(
              input.legacy.functions.map((fn) => Object.freeze({ name: fn.name })),
            ),
          }),
        }
      : {}),
  };
  assertCleanAwsEnvironment(process.env);
  // The same public transport guard is used by the runtime and the tooling. No SDK request here.
  createLabTransport().requestHandler.destroy();
  await mkdir(dirname(options.statePath), { recursive: true });
  let lock;
  try {
    lock = await open(`${options.statePath}.lock`, "wx", 0o600);
  } catch {
    throw new LabError("Lab is locked by another operation; refusing concurrent mutation.");
  }
  const close = async () => {
    await lock.close();
    await rm(`${options.statePath}.lock`, { force: true });
  };
  try {
    let manifest: LabManifest;
    let persisted = true;
    try {
      manifest = decodeManifest(
        await readManifest(options.statePath),
        options.expected,
        options.legacy,
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      if (options.operation !== "up" || !options.profile)
        throw new LabError("No owned lab manifest. Run local:up first.");
      persisted = false;
      const profile = parseProfile(options.profile);
      if (
        profile.instanceId !== options.expected.instanceId ||
        profile.project !== options.expected.project
      )
        throw new LabError("Lab profile instance mismatch.");
      manifest = {
        schemaVersion: 2,
        instanceId: profile.instanceId,
        ownerId: randomUUID(),
        image: localstackImage,
        status: "starting",
        architecture: process.arch === "arm64" ? "arm64" : "x86_64",
        mappings: [],
        profile,
        profileHash: profileHash(profile),
        entitlement: { plan: "hobby", attestedAt: new Date().toISOString() },
      };
    }
    if (manifest.schemaVersion === 1 && options.operation !== "down")
      throw new LabError("Legacy lab manifests support owned down only; no adoption or upgrade.");
    if (options.operation !== "down") {
      if (
        manifest.schemaVersion !== 2 ||
        !options.profile ||
        profileHash(options.profile) !== manifest.profileHash
      )
        throw new LabError("Lab profile changed; explicit owned down/recreation required.");
      await verifyArchives(manifest.profile);
    }
    const session = new LabSession(options, manifest, close, persisted);
    return session;
  } catch (error) {
    await close();
    throw error;
  }
}
type LabOptions = Parameters<typeof openLab>[0];
export class LabSession {
  readonly docker: DockerCommand;
  private readonly ownerId: string;
  private readonly identity: string;
  private closed = false;
  private legacyNetworkId: string | undefined;
  constructor(
    private readonly options: LabOptions,
    public manifest: LabManifest,
    private readonly release: () => Promise<void>,
    private persisted: boolean,
  ) {
    this.ownerId = manifest.ownerId;
    this.identity = manifest.schemaVersion === 2 ? manifest.profileHash : "legacy-down-only";
    this.docker = options.docker ?? createDockerCommand(dirname(options.statePath));
  }
  private current() {
    if (this.closed) throw new LabError("Lab session is closed.");
    const value = decodeManifest(this.manifest, this.options.expected, this.options.legacy);
    if (
      value.ownerId !== this.ownerId ||
      (value.schemaVersion === 2 ? value.profileHash : "legacy-down-only") !== this.identity
    )
      throw new LabError("Lab ownership/profile changed during operation.");
    return value;
  }
  private runtimeProfile(): RuntimeProfile {
    const m = this.current();
    return m.schemaVersion === 2 ? m.profile : this.options.legacy!;
  }
  async save() {
    if (this.options.operation === "down")
      throw new LabError("Teardown cannot rewrite a lab manifest.");
    const m = this.current();
    if (this.persisted) await this.assertManifestOnDisk();
    const temp = `${this.options.statePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(m, null, 2), { mode: 0o600, flag: "wx" });
      await rename(temp, this.options.statePath);
      this.persisted = true;
    } finally {
      await rm(temp, { force: true });
    }
  }
  async inspect() {
    const m = this.current(),
      profile = this.runtimeProfile(),
      project = profile.project;
    const candidates = new Set<string>();
    for (const filter of [
      `label=com.docker.compose.project=${project}`,
      `name=^/${project}-localstack-1$`,
    ])
      ids(await this.docker(["ps", "-aq", "--filter", filter])).forEach((id) => candidates.add(id));
    const containers = [];
    for (const id of candidates) {
      const value = inspectedSchema.parse(
        JSON.parse(
          await this.docker([
            "inspect",
            "--format",
            '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"status":{{json .State.Status}},"labels":{{json .Config.Labels}},"ports":{{json .HostConfig.PortBindings}}}',
            id,
          ]),
        ),
      );
      if (
        !value.id.startsWith(id) ||
        value.name !== `/${project}-localstack-1` ||
        value.image !== localstackImage ||
        !isDeepStrictEqual(value.ports, {
          "4566/tcp": [{ HostIp: "127.0.0.1", HostPort: "4566" }],
        }) ||
        value.labels?.["jawstack.owner"] !== m.ownerId ||
        value.labels["com.docker.compose.project"] !== project ||
        value.labels["com.docker.compose.service"] !== "localstack" ||
        (m.schemaVersion === 2 && value.labels["jawstack.profile"] !== m.profileHash)
      )
        throw new LabError(
          "Emulator container ownership/image/profile is not proven; manifest retained.",
        );
      if (!["running", "exited", "created"].includes(value.status))
        throw new LabError("Emulator is in an unsafe transition; manifest retained.");
      containers.push(value);
    }
    if (containers.length > 1) throw new LabError("No unique owned emulator container.");
    const runtimes = await inspectRuntimes(this.docker, profile, m.ownerId);
    const networks = ids(
      await this.docker([
        "network",
        "ls",
        "--filter",
        `name=^${project}-lab$`,
        "--format",
        "{{.ID}}",
      ]),
    );
    if (networks.length > 1) throw new LabError("Ambiguous lab network inventory.");
    let network;
    if (networks[0]) {
      network = networkSchema.parse(
        JSON.parse(
          await this.docker([
            "network",
            "inspect",
            "--format",
            '{"id":{{json .Id}},"name":{{json .Name}},"labels":{{json .Labels}},"containers":{{json .Containers}}}',
            networks[0],
          ]),
        ),
      );
      const members = new Set([...containers, ...runtimes].map((c) => c.id));
      if (
        !network.id.startsWith(networks[0]) ||
        network.name !== `${project}-lab` ||
        network.labels?.["com.docker.compose.project"] !== project ||
        network.labels["com.docker.compose.network"] !== "lab" ||
        (m.schemaVersion === 2 &&
          (network.labels["jawstack.owner"] !== m.ownerId ||
            network.labels["jawstack.profile"] !== m.profileHash)) ||
        Object.keys(network.containers ?? {}).some((id) => !members.has(id))
      )
        throw new LabError("Network ownership/membership is not proven; manifest retained.");
      if (m.schemaVersion === 1) {
        if (
          this.legacyNetworkId
            ? this.legacyNetworkId !== network.id
            : !Object.keys(network.containers ?? {}).length
        )
          throw new LabError("Legacy network ownership is not proven; manifest retained.");
        this.legacyNetworkId = network.id;
      }
    }
    return { containers, runtimes, network };
  }
  async ready() {
    if ((await this.inspect()).containers.filter((c) => c.status === "running").length !== 1)
      throw new LabError("No unique running owned emulator.");
    await waitFor("LocalStack readiness", async () => {
      try {
        const response = await fetch(`${hostEndpoint}/_localstack/health`, {
          signal: AbortSignal.timeout(2_000),
          redirect: "error",
        });
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    });
  }
  async up(settings: { tokenFile?: string; planKey?: string; labIdKey?: string } = {}) {
    if (this.options.operation !== "up" || this.current().schemaVersion !== 2)
      throw new LabError("Session is not authorized for startup.");
    const m = this.manifest;
    if (m.schemaVersion !== 2) throw new LabError("Legacy startup is not supported.");
    await verifyArchives(m.profile);
    const inventory = await this.inspect();
    if (!inventory.containers.length && (inventory.runtimes.length || inventory.network))
      throw new LabError("Owned orphans remain; run local:down before restarting.");
    const planKey = settings.planKey ?? "JAWSTACK_LOCALSTACK_PLAN";
    const labIdKey = settings.labIdKey;
    if (
      [planKey, ...(labIdKey ? [labIdKey] : [])].some((key) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(key))
    )
      throw new LabError("Invalid startup plan setting.");
    let file: NodeJS.ProcessEnv = {};
    if (settings.tokenFile) {
      try {
        file = parseEnv(await readFile(settings.tokenFile, "utf8"));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
          throw new LabError("Cannot read explicit startup token file.");
      }
      if (
        Object.keys(file).some(
          (k) => !["LOCALSTACK_AUTH_TOKEN", planKey, ...(labIdKey ? [labIdKey] : [])].includes(k),
        )
      )
        throw new LabError("The local token file contains an unsupported setting.");
      if (labIdKey && file[labIdKey] && file[labIdKey] !== m.instanceId)
        throw new LabError("Token-file lab ID differs from the explicit lab identity.");
    }
    const env = { ...file, ...process.env };
    if (!env.LOCALSTACK_AUTH_TOKEN?.trim())
      throw new LabError(
        "Set LOCALSTACK_AUTH_TOKEN in the explicitly selected ignored token file or startup environment; never paste it into chat or Git.",
      );
    if (env[planKey] !== "hobby")
      throw new LabError(`Confirm Hobby (not trial) using ${planKey}=hobby.`);
    m.entitlement = { plan: "hobby", attestedAt: new Date().toISOString() };
    await this.save();
    const compose = {
      services: {
        localstack: {
          image: localstackImage,
          ports: ["127.0.0.1:4566:4566"],
          environment: {
            LOCALSTACK_AUTH_TOKEN: "${LOCALSTACK_AUTH_TOKEN:?LocalStack token required}",
            LOCALSTACK_HOST: "localstack:4566",
            LAMBDA_DOCKER_NETWORK: `${m.profile.project}-lab`,
            LAMBDA_DOCKER_FLAGS: `--label jawstack.owner=${m.ownerId} --label jawstack.lab=${m.profile.project} --label jawstack.runtime=lambda`,
            SQS_ENDPOINT_STRATEGY: "off",
            LS_LOG: "warn",
            PERSISTENCE: "0",
          },
          labels: { "jawstack.owner": m.ownerId, "jawstack.profile": m.profileHash },
          volumes: ["/var/run/docker.sock:/var/run/docker.sock"],
          networks: ["lab"],
        },
      },
      networks: {
        lab: {
          name: `${m.profile.project}-lab`,
          labels: { "jawstack.owner": m.ownerId, "jawstack.profile": m.profileHash },
        },
      },
    };
    const composePath = `${this.options.statePath}.${randomUUID()}.compose.json`;
    await writeFile(composePath, JSON.stringify(compose), { mode: 0o600, flag: "wx" });
    try {
      const startupDocker =
        this.options.docker ??
        createDockerCommand(dirname(this.options.statePath), {
          LOCALSTACK_AUTH_TOKEN: env.LOCALSTACK_AUTH_TOKEN,
        });
      await startupDocker([
        "compose",
        "--project-name",
        m.profile.project,
        "--file",
        composePath,
        "up",
        "--detach",
        "--wait",
      ]);
      await this.ready();
    } finally {
      await rm(composePath, { force: true });
    }
    return {
      status: "ready",
      endpoint: hostEndpoint,
      project: m.profile.project,
      architecture: m.architecture,
      image: m.image,
      entitlement: "Hobby (user attested)",
    };
  }
  async down() {
    await this.assertManifestOnDisk();
    const initial = await this.inspect();
    // Preflight all candidates/network before stopping the creator; then reconcile children again.
    for (const c of initial.containers)
      if (c.status === "running") await this.docker(["stop", "--time", "30", c.id]);
    const runtimes = await cleanupRuntimes(this.docker, this.runtimeProfile(), this.ownerId);
    const stopped = await this.inspect();
    for (const c of stopped.containers) {
      if (!["exited", "created"].includes(c.status))
        throw new LabError("Emulator is not stopped; manifest retained.");
      await this.docker(["rm", c.id]);
    }
    const empty = await this.inspect();
    if (empty.containers.length || empty.runtimes.length)
      throw new LabError("Owned container cleanup incomplete; manifest retained.");
    if (empty.network) await this.docker(["network", "rm", empty.network.id]);
    const final = await this.inspect();
    if (final.containers.length || final.runtimes.length || final.network)
      throw new LabError("Owned cleanup incomplete; manifest retained.");
    await this.assertManifestOnDisk();
    await rm(this.options.statePath);
    return {
      ...runtimes,
      emulatorContainers: 0,
      lambdaContainers: 0,
      networks: 0,
      imagesRetained: true,
    };
  }
  private async assertManifestOnDisk() {
    const onDisk = decodeManifest(
      await readManifest(this.options.statePath),
      this.options.expected,
      this.options.legacy,
    );
    if (
      onDisk.ownerId !== this.ownerId ||
      (onDisk.schemaVersion === 2 ? onDisk.profileHash : "legacy-down-only") !== this.identity
    )
      throw new LabError("Manifest changed; refusing removal.");
  }
  async close() {
    if (!this.closed) {
      this.closed = true;
      await this.release();
    }
  }
}
