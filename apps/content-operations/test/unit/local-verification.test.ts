import { beforeAll, describe, expect, it, vi } from "vitest";
import { GetItemCommand, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import { createHash } from "node:crypto";
import { GetFunctionCommand, UpdateFunctionCodeCommand } from "@aws-sdk/client-lambda";
import { createLabConfig } from "../../src/lab/config";
import {
  ownedRuntime,
  inspectRuntimes,
  cleanupRuntimes,
  type DockerCommand,
} from "../../src/lab/containers";
import {
  controlKey,
  faultApplies,
  verificationHooks,
  type VerificationControl,
} from "../../src/lab/verification-state";
import { verifyIsolation } from "../../src/lab/verify-isolation";
import { buildLab, buildVerification } from "../../scripts/build-lab";
import { editorialHarness } from "../support/editorial";
import { parseContentEvent } from "../../src/shared/events";
import { instrumentWorkers } from "../../src/lab/verification-code";
import { applicationProfile } from "../../src/aws/profile";
import type { LabClients } from "../../src/lab/clients";
import { verifyRuntimeCleanup } from "../../src/lab/verify-runtime-cleanup";

const config = createLabConfig();
const ownerId = "7dc55154-f37c-499a-90a6-841fbc0cbe1c";
const container = (id = "a".repeat(64), status = "running") => ({
  id,
  status,
  name: `/${config.project}-localstack-1-lambda-${config.worker}-${"c".repeat(32)}`,
  labels: {
    "jawstack.owner": ownerId,
    "jawstack.lab": config.project,
    "jawstack.runtime": "lambda",
  },
});
describe("ownership-proven runtime cleanup", () => {
  it("rejects unlabelled, foreign, malformed, and unknown-function lookalikes", () => {
    expect(ownedRuntime(container(), config, ownerId).id).toBe("a".repeat(64));
    for (const value of [
      { ...container(), labels: null },
      { ...container(), labels: { ...container().labels, "jawstack.owner": "foreign" } },
      { ...container(), name: container().name.replace(config.worker, "unknown-function") },
      { ...container(), name: "/foreign/runtime" },
      { ...container(), status: "paused" },
    ])
      expect(() => ownedRuntime(value, config, ownerId)).toThrow();
  });
  it("preflights all candidates before stopping/removing any container", async () => {
    const calls: string[][] = [];
    const foreign = {
      ...container("b".repeat(64)),
      labels: { ...container().labels, "jawstack.owner": "foreign" },
    };
    const docker: DockerCommand = async (args) => {
      calls.push(args);
      if (args[0] === "ps") return [container().id, foreign.id].join("\n");
      if (args[0] === "inspect")
        return JSON.stringify(args.at(-1) === foreign.id ? foreign : container());
      throw new Error("No mutation allowed");
    };
    await expect(cleanupRuntimes(docker, config, ownerId)).rejects.toThrow("ownership/name");
    expect(calls.some((args) => ["stop", "rm"].includes(args[0]!))).toBe(false);
  });
  it("stops running children, removes exited children, and confirms absence", async () => {
    const records = new Map([
      ["a".repeat(64), container()],
      ["b".repeat(64), container("b".repeat(64), "exited")],
    ]);
    const calls: string[][] = [];
    const docker: DockerCommand = async (args) => {
      calls.push(args);
      if (args[0] === "ps") return [...records.keys()].join("\n");
      if (args[0] === "inspect") return JSON.stringify(records.get(args.at(-1)!));
      if (args[0] === "stop") {
        records.get(args.at(-1)!)!.status = "exited";
        return args.at(-1)!;
      }
      if (args[0] === "rm") {
        expect(records.get(args[1]!)!.status).toBe("exited");
        records.delete(args[1]!);
        return args[1]!;
      }
      throw new Error("Unexpected Docker command");
    };
    expect(await cleanupRuntimes(docker, config, ownerId)).toEqual({ stopped: 1, removed: 2 });
    expect(calls.filter((args) => args[0] === "stop")).toHaveLength(1);
    expect(records.size).toBe(0);
  });
  it("tolerates a genuinely vanished runtime but does not swallow daemon failures", async () => {
    const docker: DockerCommand = async (args) => {
      if (args[0] === "inspect") throw new Error("inspect failed");
      return args.at(-1)?.startsWith("id=") ? "" : "a".repeat(64);
    };
    expect(await inspectRuntimes(docker, config, ownerId)).toEqual([]);
    const failing: DockerCommand = async (args) => {
      if (args[0] === "inspect") throw new Error("daemon failure");
      return "a".repeat(64);
    };
    await expect(inspectRuntimes(failing, config, ownerId)).rejects.toThrow("daemon failure");
  });
  it("requires foreign refusal before stopping, then removes running and exited owned fixtures", async () => {
    const records = new Map([[container().id, container()]]);
    let created = 0;
    let refused = false;
    let starts = 0;
    const docker: DockerCommand = async (args) => {
      if (args[0] === "ps") {
        const id = args.at(-1)?.startsWith("id=") ? args.at(-1)!.slice(3) : undefined;
        return [...records.keys()].filter((key) => !id || key.startsWith(id)).join("\n");
      }
      if (args[0] === "inspect") {
        const record = records.get(args.at(-1)!)!;
        if (args[2] === "{{.Image}}") return `sha256:${"d".repeat(64)}`;
        if (args[2] === "{{.State.Status}}") return record.status;
        if (args[2]?.includes("jawstack.owner")) return record.labels["jawstack.owner"];
        return JSON.stringify(record);
      }
      if (args[0] === "create") {
        expect(args.slice(-4, -1)).toEqual(["/bin/sh", `sha256:${"d".repeat(64)}`, "-c"]);
        const id = ["b", "c", "d"][created++]!.repeat(64);
        const labels = args.filter((_, i) => args[i - 1] === "--label");
        records.set(id, {
          ...container(id, "created"),
          name: `/${args[args.indexOf("--name") + 1]}`,
          labels: Object.fromEntries(labels.map((label) => label.split("="))) as ReturnType<
            typeof container
          >["labels"],
        });
        return id;
      }
      if (args[0] === "start") {
        starts++;
        records.get(args.at(-1)!)!.status = args.includes("--attach") ? "exited" : "running";
        return "";
      }
      if (args[0] === "stop") {
        expect(refused).toBe(true);
        records.get(args.at(-1)!)!.status = "exited";
        return "";
      }
      if (args[0] === "rm") {
        records.delete(args[1]!);
        return "";
      }
      throw new Error("Unexpected command");
    };
    const shutdown = async () => {
      try {
        await inspectRuntimes(docker, config, ownerId);
      } catch (error) {
        refused = true;
        throw error;
      }
      return cleanupRuntimes(docker, config, ownerId);
    };
    expect(await verifyRuntimeCleanup(docker, config, ownerId, shutdown)).toMatchObject({
      foreignLookalikeRefusedBeforeStop: true,
      exitedOwnedFixtureRemoved: true,
      runningOwnedFixtureStoppedAndRemoved: true,
      matchingContainersAfterDown: 0,
    });
    expect(starts).toBe(2);
    expect(records.size).toBe(0);
  });
});
describe("verification-only faults", () => {
  it("executes isolated endpoint/credential probes with zero final transport calls", async () => {
    expect(await verifyIsolation()).toMatchObject({
      networkRequests: 0,
      credentialsLoaded: false,
      rejectedConfigurations: 24,
    });
  });
  it("bounds fault consumption atomically and excludes targeted recovery traffic", async () => {
    const h = editorialHarness();
    await h.create("review");
    const fact = parseContentEvent(
      h.app.persistence.store.outbox.find(
        (item) => item.eventType === "contentItem.reviewRequested",
      )!,
    );
    const control: VerificationControl = {
      ownerId,
      runId: ownerId,
      contentId: fact.resourceId,
      consumer: "deliverNotification",
      collector: false,
      mode: "transient",
      remaining: 1,
    };
    const records: Record<string, unknown>[] = [];
    const client = {
      send: vi.fn(async (command: { input: unknown }) => {
        if (command instanceof GetItemCommand)
          return {
            Item: marshall({
              ...controlKey(ownerId, fact.resourceId, control.consumer),
              ...control,
            }),
          };
        if (command instanceof PutItemCommand) {
          records.push(unmarshall(command.input.Item!));
          return {};
        }
        if (command instanceof UpdateItemCommand) {
          if (!control.remaining)
            throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
          control.remaining--;
          return {};
        }
        throw new Error("Unexpected SDK command");
      }),
    };
    const fault = await verificationHooks({
      client,
      table: "owned",
      ownerId,
      consumer: control.consumer,
      fact,
      messageId: "actual-sqs-id",
      receiveCount: 1,
      collector: false,
    });
    await expect(fault!("before")).rejects.toMatchObject({ code: "runtime.unavailable" });
    await expect(fault!("before")).resolves.toBeUndefined();
    expect(records.map((record) => record.point)).toEqual(["received", "before"]);
    expect(control.remaining).toBe(0);
    expect(faultApplies(control, { ...fact, resourceId: ownerId }, "before")).toBe(false);
    expect(
      faultApplies(
        control,
        {
          ...fact,
          recovery: {
            originalEventId: fact.eventId,
            consumer: "deliverNotification",
            failureId: "a".repeat(64),
            generation: 1,
          },
        },
        "before",
      ),
    ).toBe(false);
  });
  beforeAll(async () => {
    await buildLab();
    await buildVerification();
  }, 30_000);
  it("preflights every worker before swapping code and attempts every original archive on restore", async () => {
    const targets = applicationProfile(config).functions.filter((fn) => fn.queue);
    const hashes = new Map<string, string>();
    for (const fn of targets) {
      const bytes = await readFile(new URL(`../../dist/${fn.bundle}.zip`, import.meta.url));
      hashes.set(fn.name, createHash("sha256").update(bytes).digest("base64"));
    }
    const originalHashes = new Map(hashes);
    const verificationHash = createHash("sha256")
      .update(await readFile(new URL("../../dist/verification.zip", import.meta.url)))
      .digest("base64");
    let foreign = true;
    let restoring = false;
    const updates: string[] = [];
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof GetFunctionCommand) {
        const fn = targets.find((target) => target.name === command.input.FunctionName)!;
        return {
          Tags: { "jawstack:owner": foreign && fn === targets.at(-1) ? "foreign" : ownerId },
          Configuration: {
            Environment: { Variables: { CONTENT_OPS_OWNER_ID: ownerId } },
            Handler: fn.handler,
            CodeSha256: hashes.get(fn.name),
            State: "Active",
            LastUpdateStatus: "Successful",
          },
        };
      }
      if (!(command instanceof UpdateFunctionCodeCommand)) throw new Error("Unexpected command");
      const name = command.input.FunctionName!;
      updates.push(name);
      if (restoring && name === targets[0]!.name) throw new Error("Interrupted update");
      hashes.set(name, createHash("sha256").update(command.input.ZipFile!).digest("base64"));
      return {};
    });
    const clients = { lambda: { send } } as unknown as LabClients;
    await expect(instrumentWorkers(clients, config, ownerId)).rejects.toThrow();
    expect(updates).toEqual([]);
    foreign = false;
    const restore = await instrumentWorkers(clients, config, ownerId);
    expect([...hashes.values()].every((hash) => hash === verificationHash)).toBe(true);
    restoring = true;
    await expect(restore()).rejects.toThrow("Failed to restore 1 owned worker archives");
    expect(updates.slice(targets.length)).toEqual(targets.map((fn) => fn.name));
    for (const fn of targets.slice(1))
      expect(hashes.get(fn.name)).toBe(originalHashes.get(fn.name));
  });
  it("keeps fault plans out of standard bundles and imports verification code without side effects", async () => {
    for (const name of ["spine", "publication", "jobs", "recovery"]) {
      const files = unzipSync(await readFile(new URL(`../../dist/${name}.zip`, import.meta.url)));
      expect(Buffer.from(files["index.mjs"]!).toString()).not.toContain(
        "Verification control ownership mismatch",
      );
    }
    const files = unzipSync(
      await readFile(new URL("../../dist/verification.zip", import.meta.url)),
    );
    const dir = await mkdtemp(join(tmpdir(), "content-verification-"));
    try {
      const path = join(dir, "index.mjs");
      await writeFile(path, files["index.mjs"]!);
      const result = await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const api = await import(${JSON.stringify(pathToFileURL(path).href)}); for(const name of ["publisher","worker","collector"]) if(typeof api[name] !== "function") throw new Error("Missing verification handler");`,
        ],
        { timeout: 10_000, env: { PATH: process.env.PATH, AWS_PROFILE: "must-not-load" } },
      );
      expect(result.stdout).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
