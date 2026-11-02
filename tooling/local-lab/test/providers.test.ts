import { access, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as lambda from "@aws-sdk/client-lambda";
import * as events from "@aws-sdk/client-eventbridge";
import * as ddb from "@aws-sdk/client-dynamodb";
import * as s3 from "@aws-sdk/client-s3";
import { fixture, manifest, dockerDouble } from "./support";
import { openLab } from "../src/session";
import { parseProfile, type LabManifest, type LabProfile } from "../src/config";
import { arn, serviceContext } from "../src/service-plan";
import { profileHash } from "../src/profile";
import { inspectServices, pages } from "../src/preflight";
import { provisionServices, resetServices } from "../src/providers";
import { removeRouting, writeRouting } from "../src/routing";
import { serviceDouble } from "./service-double";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
async function setup(label = "first") {
  const f = await fixture(label);
  cleanups.push(f.clean);
  const p = structuredClone(f.profile),
    prefix = p.project;
  const worker = p.functions[0]!.name,
    collector = `${prefix}-collector`,
    dispatcher = `${prefix}-dispatcher`,
    role = `${prefix}-scheduler`;
  p.functions.push(
    { ...p.functions[0]!, name: collector },
    { ...p.functions[0]!, name: dispatcher },
  );
  const queue = `${prefix}-queue`,
    dlq = `${prefix}-dlq`,
    bus = `${prefix}-events`,
    bucket = `${prefix}-artifacts`,
    group = `${prefix}-jobs`,
    table = p.resources.tables[0]!;
  p.resources = {
    tables: [table],
    buses: [bus],
    queues: [queue, dlq],
    roles: [worker, collector, dispatcher, role],
    buckets: [bucket],
    scheduleGroups: [group],
  };
  p.services = {
    schemaVersion: 1,
    tables: [{ name: table }],
    buses: [{ name: bus }],
    queues: [
      { name: dlq, visibility: 180, retention: 1209600 },
      { name: queue, visibility: 180, retention: 345600, dlq, receives: 3 },
    ],
    buckets: [{ name: bucket }],
    roles: [
      ...[worker, collector, dispatcher].map((name) => ({
        name,
        service: "lambda.amazonaws.com" as const,
        policyName: "runtime",
        statements: [{ actions: ["dynamodb:GetItem" as const], resources: [arn("table", table)] }],
      })),
      {
        name: role,
        service: "scheduler.amazonaws.com",
        policyName: "invoke",
        statements: [{ actions: ["lambda:InvokeFunction"], resources: [arn("function", worker)] }],
      },
    ],
    functions: [worker, collector, dispatcher].map((name) => ({
      name,
      role: name,
      timeout: 30,
      memory: 256,
      concurrency: 2,
      environment: { EXAMPLE_LAB_ID: p.instanceId },
      ownerEnvironmentKey: "EXAMPLE_OWNER_ID",
    })),
    rules: [
      {
        name: "created",
        bus,
        source: `example.${p.instanceId}`,
        eventTypes: ["example.created"],
        queue,
        targetId: "consumer",
      },
    ],
    mappings: [
      {
        functionName: worker,
        source: { kind: "queue", name: queue },
        batchSize: 1,
        concurrency: 2,
      },
      {
        functionName: collector,
        source: { kind: "queue", name: dlq },
        batchSize: 1,
        concurrency: 2,
      },
      { functionName: dispatcher, source: { kind: "stream", name: table }, batchSize: 10 },
    ],
    scheduleGroups: [{ name: group }],
    schedules: [
      {
        name: "due",
        group,
        functionName: worker,
        role,
        enabled: true,
        input: { targetHandler: "due" },
        failureQueue: dlq,
      },
    ],
  };
  const profile = parseProfile(p),
    m = manifest(profile),
    d = serviceDouble(),
    save = vi.fn(async () => {});
  return {
    ...f,
    profile,
    m,
    d,
    save,
    worker,
    collector,
    dispatcher,
    queue,
    dlq,
    bus,
    bucket,
    group,
    table,
  };
}
const mutations = (calls: string[]) =>
  calls.filter((c) => /^(Create|Put|Set|Delete|Remove|Update)/.test(c));
describe("finite service providers", () => {
  it.each(["alpha", "beta"])(
    "provisions, audits, resets and reprovisions an independent %s consumer",
    async (label) => {
      const h = await setup(label);
      await provisionServices(h.d.clients, h.m, h.save);
      expect(h.m.status).toBe("ready");
      expect(h.m.mappings).toHaveLength(3);
      const inv = await inspectServices(h.d.clients, h.m, "ready");
      expect(inv.functions).toHaveLength(3);
      expect(inv.queues).toHaveLength(2);
      expect(inv.schedules).toHaveLength(1);
      const firstSchedule = h.d.calls.indexOf("CreateScheduleCommand"),
        lastMapping = h.d.calls.lastIndexOf("CreateEventSourceMappingCommand");
      expect(firstSchedule).toBeGreaterThan(lastMapping);
      h.d.buckets.get(h.bucket)!.keys = ["one", "two"];
      h.d.tables.set(`${h.profile.project}-sentinel`, {
        TableName: `${h.profile.project}-sentinel`,
        Tags: [{ Key: "jawstack:owner", Value: "other" }],
      });
      h.d.calls.length = 0;
      await resetServices(h.d.clients, h.m);
      expect(h.d.tables.size).toBe(1);
      expect(h.d.calls.indexOf("DeleteScheduleCommand")).toBeLessThan(
        h.d.calls.indexOf("DeleteFunctionCommand"),
      );
      expect(h.d.calls.indexOf("DeleteEventSourceMappingCommand")).toBeLessThan(
        h.d.calls.indexOf("DeleteQueueCommand"),
      );
      h.m.status = "starting";
      h.m.mappings = [];
      await provisionServices(h.d.clients, h.m, h.save);
      expect(h.m.status).toBe("ready");
    },
  );
  it("refuses pre-existing queues instead of relying on idempotent CreateQueue", async () => {
    const h = await setup();
    h.d.queues.set(h.queue, { QueueName: h.queue, tags: { foreign: "true" } });
    await expect(provisionServices(h.d.clients, h.m, h.save)).rejects.toThrow("refusing adoption");
    expect(mutations(h.d.calls)).toEqual([]);
    expect(h.m.status).toBe("starting");
  });
  it.each(["table", "queue", "role", "function", "log", "bucket", "group"])(
    "preflights foreign %s ownership before any deletion",
    async (kind) => {
      const h = await setup();
      await provisionServices(h.d.clients, h.m, h.save);
      if (kind === "table")
        h.d.tables.get(h.table)!.Tags = [{ Key: "jawstack:owner", Value: "foreign" }];
      if (kind === "queue") h.d.queues.get(h.queue)!.tags = { "jawstack:owner": "foreign" };
      if (kind === "role")
        h.d.roles.get(h.profile.resources.roles.at(-1)!)!.Tags = [
          { Key: "jawstack:owner", Value: "foreign" },
        ];
      if (kind === "function") h.d.functions.get(h.worker)!.Tags = { "jawstack:owner": "foreign" };
      if (kind === "log")
        h.d.logGroups.get(`/aws/lambda/${h.worker}`)!.tags = { "jawstack:owner": "foreign" };
      if (kind === "bucket")
        h.d.buckets.get(h.bucket)!.tags = [{ Key: "jawstack:owner", Value: "foreign" }];
      if (kind === "group")
        h.d.groups.get(h.group)!.Tags = [{ Key: "jawstack:owner", Value: "foreign" }];
      h.d.calls.length = 0;
      await expect(resetServices(h.d.clients, h.m)).rejects.toThrow("not owned");
      expect(mutations(h.d.calls)).toEqual([]);
    },
  );
  it.each([
    "archive",
    "timeout",
    "environment",
    "concurrency",
    "queue",
    "mapping",
    "target",
    "schedule",
    "policy",
    "extra-policy",
    "extra-schedule",
    "versioning",
    "queue-policy",
  ])("refuses %s drift before reset", async (kind) => {
    const h = await setup();
    await provisionServices(h.d.clients, h.m, h.save);
    if (kind === "archive") h.d.functions.get(h.worker)!.Code = { ZipFile: Buffer.from("changed") };
    if (kind === "timeout") h.d.functions.get(h.worker)!.Timeout = 900;
    if (kind === "environment")
      h.d.functions.get(h.worker)!.Environment = { Variables: { EXAMPLE_LAB_ID: "foreign" } };
    if (kind === "concurrency") h.d.concurrency.set(h.worker, 100);
    if (kind === "queue") h.d.queues.get(h.queue)!.Attributes!.VisibilityTimeout = "1";
    if (kind === "mapping") h.d.mappings.values().next().value!.EventSourceArn = "foreign";
    if (kind === "target")
      h.d.targets.values().next().value!.Targets = [{ Id: "foreign", Arn: "foreign" }];
    if (kind === "schedule") h.d.schedules.values().next().value!.Target!.RoleArn = "foreign";
    if (kind === "policy") h.d.policies.set(`${h.worker}/runtime`, "{}");
    if (kind === "extra-policy") h.d.policies.set(`${h.worker}/foreign`, "{}");
    if (kind === "extra-schedule")
      h.d.schedules.set(`${h.group}/foreign`, {
        ...h.d.schedules.values().next().value!,
        Name: "foreign",
      });
    if (kind === "versioning") h.d.buckets.get(h.bucket)!.versioning = "Enabled";
    if (kind === "queue-policy") h.d.queues.get(h.queue)!.Attributes!.Policy = "{}";
    h.d.calls.length = 0;
    await expect(resetServices(h.d.clients, h.m)).rejects.toThrow("Unexpected");
    expect(mutations(h.d.calls)).toEqual([]);
  });
  it("discovers mappings lost between creation and manifest save", async () => {
    const h = await setup();
    await provisionServices(h.d.clients, h.m, h.save);
    h.m.mappings = [];
    await resetServices(h.d.clients, h.m);
    expect(h.d.mappings.size).toBe(0);
  });
  it("retains partial provisioning and permits ownership-checked cleanup", async () => {
    const h = await setup();
    h.d.setHook((command) => {
      if (command instanceof lambda.CreateFunctionCommand) throw Error("injected create failure");
    });
    await expect(provisionServices(h.d.clients, h.m, h.save)).rejects.toThrow("injected");
    expect(h.m.status).toBe("provisioning");
    h.d.setHook(undefined);
    await resetServices(h.d.clients, h.m);
    expect(h.d.tables.size).toBe(0);
    expect(h.d.buckets.size).toBe(0);
  });
  it("fails closed on an untagged create/tag crash window", async () => {
    const h = await setup();
    h.d.setHook((command) => {
      if (command instanceof s3.PutBucketTaggingCommand) throw Error("lost tagging");
    });
    await expect(provisionServices(h.d.clients, h.m, h.save)).rejects.toThrow("tagging");
    h.d.setHook(undefined);
    h.d.calls.length = 0;
    await expect(resetServices(h.d.clients, h.m)).rejects.toThrow("not owned");
    expect(mutations(h.d.calls)).toEqual([]);
  });
  it("rejects repeated object cursors before deleting even the first service", async () => {
    const h = await setup();
    await provisionServices(h.d.clients, h.m, h.save);
    h.d.setHook((command) =>
      command instanceof s3.ListObjectsV2Command
        ? { Contents: [], IsTruncated: true, NextContinuationToken: "repeat" }
        : undefined,
    );
    h.d.calls.length = 0;
    await expect(resetServices(h.d.clients, h.m)).rejects.toThrow("repeats a cursor");
    expect(mutations(h.d.calls)).toEqual([]);
  });
  it("supports finite pagination and rejects broken/missing cursors", async () => {
    const h = await setup();
    await provisionServices(h.d.clients, h.m, h.save);
    let count = 0;
    h.d.setHook((command) =>
      command instanceof ddb.ListTagsOfResourceCommand
        ? ++count === 1
          ? { Tags: [], NextToken: "page2" }
          : { Tags: h.d.tables.get(h.table)!.Tags }
        : undefined,
    );
    await inspectServices(h.d.clients, h.m, "ready");
    expect(count).toBe(2);
    const request = vi.fn(async () => ({ values: [], cursor: "again" }));
    await expect(pages(request)).rejects.toThrow("repeats");
    expect(request).toHaveBeenCalledTimes(2);
    let n = 0;
    await expect(pages(async () => ({ values: [], cursor: String(++n) }))).rejects.toThrow(
      "budget",
    );
    expect(n).toBe(10);
    h.d.setHook((command) =>
      command instanceof s3.ListObjectsV2Command ? { Contents: [], IsTruncated: true } : undefined,
    );
    await expect(resetServices(h.d.clients, h.m)).rejects.toThrow("continuation token");
  });
  it("refuses failed event target attachment without declaring readiness", async () => {
    const h = await setup();
    h.d.setHook((command) =>
      command instanceof events.PutTargetsCommand ? { FailedEntryCount: 1 } : undefined,
    );
    await expect(provisionServices(h.d.clients, h.m, h.save)).rejects.toThrow("target");
    expect(h.m.status).toBe("provisioning");
  });
  it("does not emit routing until all resources verify, invalidates only its own data", async () => {
    const h = await setup(),
      path = `${h.statePath}.routing.json`;
    await expect(writeRouting(path, h.m)).rejects.toThrow("ready");
    await expect(access(path)).rejects.toThrow();
    await provisionServices(h.d.clients, h.m, h.save);
    await writeRouting(path, h.m);
    const value = JSON.parse(await readFile(path, "utf8"));
    expect(value.profileHash).toBe(h.m.profileHash);
    expect(JSON.stringify(value)).not.toMatch(/archive|TOKEN|ENDPOINT|credentials/);
    await expect(
      removeRouting(path, { ...h.m, ownerId: "bfe60d77-f9c9-42be-976b-1b3a747a16d4" }),
    ).rejects.toThrow("Foreign");
    await removeRouting(path, h.m);
    await expect(access(path)).rejects.toThrow();
  });
  it.each([
    "legacy",
    "no-plan",
    "grants",
    "subscription",
    "inventory",
    "environment",
    "queue-bound",
    "principal",
    "bucket",
  ])("rejects %s configuration before SDK calls", async (kind) => {
    const h = await setup(),
      p = structuredClone(h.profile);
    if (kind === "no-plan") delete p.services;
    if (kind === "grants") p.services!.roles[0]!.statements[0]!.resources = ["*"];
    if (kind === "subscription") p.services!.mappings[0]!.source.name = "foreign";
    if (kind === "inventory") p.services!.queues.pop();
    if (kind === "environment") p.services!.functions[0]!.environment.AWS_PROFILE = "forbidden";
    if (kind === "queue-bound") p.services!.queues[1]!.visibility = 1;
    if (kind === "principal") p.services!.roles[0]!.service = "scheduler.amazonaws.com";
    if (kind === "bucket") {
      const name = `${p.project}-INVALID`;
      p.resources.buckets = [name];
      p.services!.buckets = [{ name }];
    }
    const m: LabManifest =
      kind === "legacy"
        ? {
            schemaVersion: 1,
            instanceId: h.m.instanceId,
            ownerId: h.m.ownerId,
            image: h.m.image,
            status: "starting",
            architecture: "arm64",
            mappings: [],
          }
        : { ...h.m, profile: parseProfile(p), profileHash: profileHash(p) };
    await expect(provisionServices(h.d.clients, m, h.save)).rejects.toThrow();
    expect(h.d.calls).toEqual([]);
  });
  it("keeps explicit profile/asset identity captured rather than trusting mutable caller data", async () => {
    const h = await setup();
    const source = structuredClone(h.m);
    const context = serviceContext(source);
    (source.profile as LabProfile).services!.functions[0]!.timeout = 1;
    expect(context.plan.functions[0]!.timeout).toBe(30);
  });
  it("supports workflow ownership tags and late-bound profile identity without consumer-specific providers", async () => {
    const h = await setup(),
      p = structuredClone(h.profile);
    p.services!.workflowHash = "a".repeat(64);
    p.services!.functions[0]!.profileEnvironmentKey = "EXAMPLE_PROFILE_HASH";
    const m = manifest(parseProfile(p));
    await provisionServices(h.d.clients, m, h.save);
    expect(h.d.tables.get(h.table)!.Tags).toContainEqual({
      Key: "jawstack:workflow",
      Value: "a".repeat(64),
    });
    expect(h.d.tables.get(h.table)!.Tags).toContainEqual({
      Key: "jawstack:lab",
      Value: p.instanceId,
    });
    expect(h.d.functions.get(h.worker)!.Environment!.Variables!.EXAMPLE_PROFILE_HASH).toBe(
      m.profileHash,
    );
    await inspectServices(h.d.clients, m, "ready");
  });
  it("checkpoints reset and safely resumes after a late object deletion failure", async () => {
    const h = await setup();
    await provisionServices(h.d.clients, h.m, h.save);
    h.d.buckets.get(h.bucket)!.keys = ["one"];
    h.d.setHook((c) =>
      c instanceof s3.DeleteObjectsCommand ? { Errors: [{ Code: "Denied" }] } : undefined,
    );
    await expect(resetServices(h.d.clients, h.m, h.save)).rejects.toThrow("Object cleanup failed");
    expect(h.m.status).toBe("resetting");
    expect(h.d.functions.size).toBe(0);
    h.d.setHook(undefined);
    await resetServices(h.d.clients, h.m, h.save);
    expect(h.d.tables.size).toBe(0);
    expect(h.d.roles.size).toBe(0);
    expect(h.d.buckets.size).toBe(0);
  });
  it("repeat provisioning refuses without deleting a valid ready routing file", async () => {
    const h = await setup();
    await provisionServices(h.d.clients, h.m, h.save);
    await writeFile(h.statePath, JSON.stringify(h.m));
    const path = `${h.statePath}.routing.json`;
    await writeRouting(path, h.m);
    const before = await readFile(path, "utf8");
    const docker = dockerDouble(h.profile);
    const session = await openLab({ ...h, operation: "inspect", docker: docker.docker });
    try {
      await expect(session.provision()).rejects.toThrow("already");
      expect(await readFile(path, "utf8")).toBe(before);
      expect(docker.calls).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
