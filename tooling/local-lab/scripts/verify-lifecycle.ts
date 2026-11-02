import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { zipSync } from "fflate";
import { IAMClient, CreateRoleCommand } from "@aws-sdk/client-iam";
import {
  LambdaClient,
  CreateFunctionCommand,
  GetFunctionConfigurationCommand,
  InvokeCommand,
} from "@aws-sdk/client-lambda";
import {
  archiveIdentity,
  createLabTransport,
  inspectRuntimes,
  LabError,
  localstackImage,
  openLab,
  parseProfile,
  waitFor,
} from "../src/index";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--token-file" || args[2] !== "--plan-key")
    throw new LabError("Use --token-file <explicit ignored file> --plan-key <Hobby setting key>.");
  const startedAt = new Date().toISOString();
  // Never start over another application's listener, even if it happens to answer health.
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(4566, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const root = await mkdtemp(join(tmpdir(), "jawstack-phase8-live-"));
  const instanceId = `p8${randomUUID().slice(0, 6)}`,
    project = `jawstack-lifecycle-${instanceId}`;
  const archivePath = join(root, "handler.zip");
  const bytes = zipSync({
    "index.mjs": [
      Buffer.from("export const handler=async()=>({status:'ok'});"),
      { mtime: new Date(2000, 0, 1) },
    ],
  });
  await writeFile(archivePath, bytes);
  const functionName = `${project}-worker`,
    roleName = `${project}-lambda`;
  const profile = parseProfile({
    schemaVersion: 1,
    instanceId,
    project,
    functions: [
      { name: functionName, handler: "index.handler", archive: await archiveIdentity(archivePath) },
    ],
    resources: {
      tables: [],
      buses: [],
      queues: [],
      roles: [roleName],
      buckets: [],
      scheduleGroups: [],
    },
  });
  const statePath = join(root, "manifest.json");
  const session = await openLab({
    statePath,
    expected: { instanceId, project },
    profile,
    operation: "up",
  });
  const transport = createLabTransport(),
    lambda = new LambdaClient(transport),
    iam = new IAMClient(transport);
  const createdFixtures = new Map<string, string>();
  let stopped = false;
  const evidence: Record<string, unknown> = {
    startedAt,
    project,
    image: localstackImage,
    scope: "actual-local-emulator-lifecycle-not-workflow-delivery-or-AWS-IAM",
  };
  const removeFixture = async (id: string) => {
    const owner = createdFixtures.get(id)!;
    const actual = await session.docker([
      "inspect",
      "--format",
      '{{index .Config.Labels "jawstack.owner"}}',
      id,
    ]);
    assert.equal(actual, owner);
    await session.docker(["rm", id]);
    createdFixtures.delete(id);
  };
  try {
    await session.up({
      tokenFile: resolve(args[1]!),
      planKey: args[3]!,
      labIdKey: "CONTENT_OPS_LAB_ID",
    });
    evidence.startup = {
      ready: true,
      schemaVersion: session.manifest.schemaVersion,
      hobbyAttested: true,
    };
    const owner = session.manifest.ownerId;
    await iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
        Tags: [{ Key: "jawstack:owner", Value: owner }],
      }),
    );
    await lambda.send(
      new CreateFunctionCommand({
        FunctionName: functionName,
        Role: `arn:aws:iam::000000000000:role/${roleName}`,
        Runtime: "nodejs22.x",
        Architectures: ["arm64"],
        Handler: "index.handler",
        MemorySize: 256,
        Timeout: 30,
        Code: { ZipFile: bytes },
        Tags: { "jawstack:owner": owner },
      }),
    );
    await waitFor("verification Lambda active", async () =>
      (await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName })))
        .State === "Active"
        ? true
        : undefined,
    );
    const invocation = await lambda.send(
      new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from("{}") }),
    );
    assert.equal(invocation.FunctionError, undefined);
    assert.equal(invocation.StatusCode, 200);
    const runtimes = await waitFor("real warm Lambda container", async () => {
      const found = await inspectRuntimes(session.docker, profile, owner);
      return found.length ? found : undefined;
    });
    evidence.actualWarmRuntimes = runtimes.length;
    const image = await session.docker(["inspect", "--format", "{{.Image}}", runtimes[0]!.id]);
    assert.match(image, /^sha256:[a-f0-9]{64}$/);
    const create = async (labelOwner: string, label = "owned", command = "exit 0") => {
      const name =
        label === "unrelated"
          ? `${project}-sentinel`
          : `${project}-localstack-1-lambda-${functionName.toLowerCase()}-${randomUUID().replaceAll("-", "")}`;
      const id = await session.docker([
        "create",
        "--name",
        name,
        "--label",
        `jawstack.owner=${labelOwner}`,
        ...(label === "unrelated"
          ? []
          : ["--label", `jawstack.lab=${project}`, "--label", "jawstack.runtime=lambda"]),
        "--entrypoint",
        "/bin/sh",
        image,
        "-c",
        command,
      ]);
      assert.match(id, /^[a-f0-9]{64}$/);
      createdFixtures.set(id, labelOwner);
      return id;
    };
    const exited = await create(owner),
      running = await create(owner, "owned", "sleep 600"),
      foreign = await create(randomUUID(), "foreign"),
      sentinel = await create(randomUUID(), "unrelated");
    await session.docker(["start", "--attach", exited]);
    await session.docker(["start", running]);
    let refused = false;
    try {
      await session.down();
    } catch (error) {
      refused = error instanceof LabError && error.message.includes("ownership/name");
    }
    assert.equal(refused, true);
    assert.equal(
      await session.docker(["inspect", "--format", "{{.State.Status}}", running]),
      "running",
    );
    assert.equal(
      (
        await session.docker([
          "ps",
          "-q",
          "--filter",
          `label=com.docker.compose.project=${project}`,
        ])
      ).length > 0,
      true,
    );
    await access(statePath);
    evidence.foreignLookalikeRefusedBeforeStop = true;
    await removeFixture(foreign);
    const inventory = await session.inspect();
    await session.docker(["stop", "--time", "30", inventory.containers[0]!.id]);
    await session.docker(["rm", inventory.containers[0]!.id]);
    let orphanRefused = false;
    try {
      await session.up();
    } catch (error) {
      orphanRefused = error instanceof LabError && error.message.includes("orphans");
    }
    assert.equal(orphanRefused, true);
    evidence.orphanRestartRefused = true;
    // Teardown has no startup settings/token-file argument and never loads that file.
    evidence.teardown = await session.down();
    stopped = true;
    for (const id of [exited, running]) {
      assert.equal(await session.docker(["ps", "-aq", "--filter", `id=${id}`]), "");
      createdFixtures.delete(id);
    }
    assert.equal(
      await session.docker(["ps", "-aq", "--filter", `id=${sentinel}`]),
      sentinel.slice(0, 12),
    );
    evidence.unrelatedSentinelPreserved = true;
    await removeFixture(sentinel);
    await assert.rejects(access(statePath));
    evidence.status = "passed";
    evidence.completedAt = new Date().toISOString();
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    lambda.destroy();
    iam.destroy();
    transport.requestHandler.destroy();
    // Exact test-owned fixtures only, never adopt a discovered foreign lookalike.
    for (const [id] of createdFixtures) {
      const status = await session.docker(["inspect", "--format", "{{.State.Status}}", id]);
      if (status === "running") await session.docker(["stop", "--time", "10", id]);
      await removeFixture(id);
    }
    try {
      if (!stopped) await session.down();
    } finally {
      await session.close();
    }
    if (stopped) await rm(root, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof LabError
      ? error.message
      : `Lifecycle proof failed (${error instanceof Error ? error.name : "unknown"}); raw output withheld.`,
  );
  process.exitCode = 1;
});
