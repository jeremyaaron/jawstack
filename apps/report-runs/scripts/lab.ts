import { parseArgs, isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { openLab, assertCleanAwsEnvironment } from "@jawstack/local-lab";
import { buildReport, root } from "./build";
import { reportProfile } from "./profile";
import { topology } from "../src/local-config";
import { openLocal } from "./open-local";
import { startReportApi } from "../src/server";
import { ReportClient } from "../src/client";
import { sha256 } from "../src/domain";
import { randomUUID } from "node:crypto";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { createLocalAwsTransport } from "@jawstack/aws-runtime/local";
import { workerIdempotencyKey } from "@jawstack/aws-runtime";
import { runCli } from "../src/cli";
import { seed, seedIds } from "./seed";
class ProofFailure extends Error {}
export async function verifyReport(labId: string) {
  const workflow = await openLocal(labId);
  const api = await startReportApi({ kind: "localstack", workflow }, { port: 4647 });
  try {
    console.log("Checking ordinary seed commands and the real Report stream/bus/queue/worker...");
    await seed(workflow);
    const client = new ReportClient(api.url);
    const input = {
      items: [
        { itemId: "B", label: " Café ", quantity: 0 },
        { itemId: "A", label: "Stock", quantity: 7 },
      ],
    };
    const key = "live:" + randomUUID();
    const created = (await client.request("/api/reports", { input, idempotencyKey: key })) as {
      data: { reportId: string };
    };
    const id = created.data.reportId;
    const until = Date.now() + 180000;
    let row: { version: number; state: { status: string; resultDigest?: string } } | undefined;
    while (Date.now() < until) {
      const status = (await client.request("/api/reports/" + id)) as {
        data: { resource: NonNullable<typeof row> };
      };
      row = status.data.resource;
      if (row.state.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (row?.state.status !== "completed" || row.version !== 2)
      throw new ProofFailure("Report did not complete.");
    for (const fixture of seedIds) {
      while (
        Date.now() < until &&
        (await workflow.repository.getState("reportRun", fixture))?.version !== 2
      )
        await new Promise((resolve) => setTimeout(resolve, 500));
      if ((await workflow.repository.getState("reportRun", fixture))?.version !== 2)
        throw new ProofFailure("Seed report did not complete.");
    }
    const activity = await workflow.queries.queryActivity({
      resourceType: "reportRun",
      resourceId: id,
      limit: 100,
    });
    const completed = activity.items.filter((item) => item.activityType === "completed");
    if (completed.length !== 1 || activity.nextCursor || !completed[0]?.causationId)
      throw new ProofFailure("Completion activity differs.");
    const transport = createLocalAwsTransport({ execution: { kind: "host" } }),
      clientDdb = new DynamoDBClient(transport);
    try {
      const key = workerIdempotencyKey("buildInventory", completed[0].causationId);
      let marked = false;
      while (Date.now() < until) {
        const result = await clientDdb.send(
          new GetItemCommand({
            TableName: topology(labId).table,
            Key: { PK: { S: key.PK }, SK: { S: key.SK } },
            ConsistentRead: true,
          }),
        );
        if (result.Item?.workerName?.S === "buildInventory") {
          marked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!marked) throw new ProofFailure("Worker completion marker missing.");
    } finally {
      clientDdb.destroy();
      transport.requestHandler.destroy();
    }
    const result = await client.request("/api/reports/" + id + "/result", undefined, true);
    if (!Buffer.isBuffer(result) || sha256(result) !== row.state.resultDigest)
      throw new ProofFailure("Stored export differs.");
    const replay = await client.request("/api/reports", { input, idempotencyKey: key });
    if (!isDeepStrictEqual(replay, created)) throw new ProofFailure("Request replay differs.");
    let denied = false;
    try {
      await new ReportClient(api.url, "requester_2").request("/api/reports/" + id);
    } catch (error) {
      denied = error instanceof Error && error.message === "Report API failed: auth.forbidden";
    }
    if (!denied) throw new ProofFailure("Foreign requester read succeeded.");
    const page = (await new ReportClient(api.url, "operator_1").request("/api/operations")) as {
      data: { items: unknown[] };
    };
    if (page.data.items.length) throw new ProofFailure("Unexpected delivery failures.");
    const event = JSON.parse(result.toString("utf8"));
    if (event.summary.totalQuantity !== 7 || event.items[0].itemId !== "A")
      throw new ProofFailure("Incorrect canonical report.");
    const cliOutput: Buffer[] = [];
    await runCli(["result", "--api", api.url, "--id", id], (value) =>
      cliOutput.push(Buffer.from(value)),
    );
    if (!Buffer.concat(cliOutput).equals(result)) throw new ProofFailure("CLI export differs.");
    return {
      status: "passed",
      processing: "external-workers",
      version: row.version,
      digest: row.state.resultDigest,
      requestReplayPinned: true,
      requesterBoundary: true,
      actualStreamBusQueueLambda: true,
      storedExportVerified: true,
      cliExportVerified: true,
      seedReportsCompleted: 2,
      completionTransitions: 1,
      successfulWorkerMarker: true,
    };
  } finally {
    await api.close();
  }
}
export async function lab(args: string[]) {
  assertCleanAwsEnvironment(process.env);
  const command = args[0];
  if (!["up", "provision", "down", "verify"].includes(command ?? ""))
    throw new Error("Unknown lab command.");
  const { values } = parseArgs({
    args: args.slice(1),
    strict: true,
    options: {
      lab: { type: "string" },
      "token-file": { type: "string" },
      "plan-key": { type: "string" },
      "confirm-teardown": { type: "boolean" },
    },
  });
  if (command !== "up" && (values["token-file"] || values["plan-key"]))
    throw new Error("Startup flags require up.");
  if ((command === "verify") !== !!values["confirm-teardown"])
    throw new Error("verify requires --confirm-teardown.");
  const t = topology(values.lab ?? "dev");
  const archives =
    command === "up" || command === "provision"
      ? await buildReport()
      : Object.fromEntries(
          ["outbox", "worker", "collector", "api"].map((name) => [
            name,
            root + "dist/" + name + ".zip",
          ]),
        );
  const profile = command === "down" ? undefined : await reportProfile(t.labId, archives);
  const session = await openLab({
    operation: command === "up" ? "up" : command === "down" ? "down" : "inspect",
    statePath: root + ".localstack/" + t.labId + ".json",
    expected: { instanceId: t.labId, project: t.project },
    ...(profile ? { profile } : {}),
  });
  try {
    if (command === "up")
      return await session.up({
        ...(values["token-file"] ? { tokenFile: resolve(values["token-file"]) } : {}),
        ...(values["plan-key"] ? { planKey: values["plan-key"] } : {}),
      });
    if (command === "down") return await session.down();
    await session.ready();
    if (command === "provision") return await session.provision();
    const startedAt = new Date().toISOString(),
      profileHash = session.manifest.schemaVersion === 2 ? session.manifest.profileHash : "";
    let proof: unknown;
    let failure: string | undefined;
    try {
      proof = await verifyReport(t.labId);
      return proof;
    } catch (error) {
      failure =
        error instanceof ProofFailure
          ? error.message
          : "Proof dependency or ingress request failed.";
      throw error;
    } finally {
      const teardown = await session.down();
      await mkdir(root + ".localstack", { recursive: true });
      await writeFile(
        root + ".localstack/" + t.labId + "-evidence.json",
        JSON.stringify(
          {
            startedAt,
            completedAt: new Date().toISOString(),
            profileHash,
            status: proof ? "passed" : "failed",
            proof,
            ...(failure ? { failure } : {}),
            teardown,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    }
  } finally {
    await session.close();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  lab(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result ?? { status: "provisioned" })))
    .catch(() => {
      console.error("Report lab operation failed; inspect owned state and sanitized evidence.");
      process.exitCode = 1;
    });
