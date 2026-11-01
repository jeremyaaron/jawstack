import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { buildLab } from "../../scripts/build-lab";
import { applicationProfile } from "../../src/aws/profile";
import { localLambdaConfig } from "../../src/aws/local-context";
import { publisher } from "../../src/aws/publication";
import { scheduled } from "../../src/aws/jobs";
import { worker, collector } from "../../src/aws/recovery";
import { contentWorkers } from "../../src/domain/subscriptions";
import { createClients } from "../../src/lab/clients";
import {
  createLabConfig,
  localQueueUrl,
  localstackImage,
  type LabManifest,
} from "../../src/lab/config";
import type { LabClients } from "../../src/lab/clients";
import {
  cleanupApplication,
  inspectApplication,
  provisionApplication,
} from "../../src/lab/application-topology";

const config = createLabConfig("runtime-test");
const profile = applicationProfile(config);
const ownerId = "7dc55154-f37c-499a-90a6-841fbc0cbe1c";
const manifest = (): LabManifest => ({
  schemaVersion: 1,
  instanceId: config.instanceId,
  ownerId,
  image: localstackImage,
  status: "provisioning",
  architecture: "arm64",
  mappings: [],
});
type Call = { name: string; input: Record<string, unknown> };
function fakeClients(reply: (call: Call) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  const send = vi.fn(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const call = { name: command.constructor.name, input: command.input };
      calls.push(call);
      return reply(call);
    },
  );
  return {
    calls,
    clients: Object.fromEntries(
      ["dynamo", "lambda", "events", "iam", "logs", "sqs", "scheduler"].map((name) => [
        name,
        { send },
      ]),
    ) as unknown as LabClients,
  };
}
const absent = () => {
  throw Object.assign(new Error(), { name: "ResourceNotFoundException" });
};

describe("actual application AWS composition", () => {
  beforeAll(buildLab, 30_000);
  it("declares every implemented consumer, collector, and job without endpoint overrides", () => {
    expect(profile.workers.map((worker) => worker.consumer)).toEqual(
      contentWorkers.map((worker) => worker.name),
    );
    expect(profile.functions).toHaveLength(9);
    expect(new Set(profile.functions.map((fn) => fn.name)).size).toBe(9);
    for (const fn of applicationProfile(createLabConfig("a".repeat(16))).functions)
      expect(fn.name.length).toBeLessThanOrEqual(64);
    expect(profile.bounds.visibility).toBeGreaterThanOrEqual(profile.bounds.timeout * 6);
    for (const name of [
      ...profile.workers.flatMap((worker) => [worker.queue, worker.dlq]),
      profile.schedulerDlq,
    ])
      expect(localQueueUrl(`http://localstack:4566/000000000000/${name}`, config, name)).toBe(
        `${config.endpoint}/000000000000/${name}`,
      );
    expect(() =>
      localQueueUrl(`${config.endpoint}/000000000000/foreign`, config, "foreign"),
    ).toThrow();
  });
  it("imports every built handler without creating clients or requiring a lab/token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "content-runtime-"));
    try {
      for (const bundle of new Set(profile.functions.map((fn) => fn.bundle))) {
        const archive = unzipSync(
          await readFile(new URL(`../../dist/${bundle}.zip`, import.meta.url)),
        );
        expect(Object.keys(archive)).toEqual(["index.mjs"]);
        const path = join(dir, `${bundle}.mjs`);
        await writeFile(path, archive["index.mjs"]!);
        const names = profile.functions
          .filter((fn) => fn.bundle === bundle)
          .map((fn) => fn.handler.split(".")[1]);
        const result = await promisify(execFile)(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `const handlers = await import(${JSON.stringify(path)}); for (const name of ${JSON.stringify(names)}) { if (typeof handlers[name] !== "function") throw new Error("Missing handler"); }`,
          ],
          { timeout: 10_000, env: { PATH: process.env.PATH, AWS_PROFILE: "must-not-be-loaded" } },
        );
        expect(result.stdout).toBe("");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("provisions exact bundles, per-function grants, queues, schedules, and bounded mappings", async () => {
    const h = fakeClients(({ name, input }) => {
      if (name === "CreateQueueCommand")
        return { QueueUrl: `${config.endpoint}/000000000000/${input.QueueName}` };
      if (name === "GetFunctionCommand") return { Configuration: { State: "Active" } };
      if (name === "CreateEventSourceMappingCommand") return { UUID: String(input.FunctionName) };
      if (name === "GetEventSourceMappingCommand") return { State: "Enabled" };
      return {};
    });
    const state = manifest();
    await provisionApplication(h.clients, config, state, async () => undefined);
    expect(state.applicationVersion).toBe(1);
    expect(state.mappings).toHaveLength(8);
    const inputs = (name: string) =>
      h.calls.filter((call) => call.name === name).map((call) => call.input);
    expect(inputs("CreateFunctionCommand")).toHaveLength(9);
    expect(inputs("CreateQueueCommand")).toHaveLength(9);
    expect(inputs("PutTargetsCommand")).toHaveLength(4);
    expect(inputs("CreateEventSourceMappingCommand")).toHaveLength(8);
    for (const fn of inputs("CreateFunctionCommand")) {
      expect(fn).toMatchObject({ Timeout: 30, MemorySize: 256, Architectures: ["arm64"] });
      expect(JSON.stringify(fn.Environment)).not.toMatch(/TOKEN|ACCESS_KEY|ENDPOINT|PROFILE/);
    }
    for (const mapping of inputs("CreateEventSourceMappingCommand"))
      expect(mapping).toMatchObject({ BatchSize: 1, ScalingConfig: { MaximumConcurrency: 2 } });
    for (const queue of inputs("CreateQueueCommand"))
      expect(queue.Attributes).toMatchObject({ VisibilityTimeout: "180" });
    expect(inputs("PutRetentionPolicyCommand").every((input) => input.retentionInDays === 7)).toBe(
      true,
    );
    expect(inputs("CreateScheduleCommand").map((input) => input.Name)).toEqual(
      profile.schedules.map((item) => item.name),
    );
    expect(h.calls.at(-1)?.name).toBe("CreateScheduleCommand");
    for (const schedule of inputs("CreateScheduleCommand"))
      expect(schedule).toMatchObject({
        State: "ENABLED",
        Target: { DeadLetterConfig: { Arn: expect.stringContaining(profile.schedulerDlq) } },
      });
    const policies = inputs("PutRolePolicyCommand");
    for (const fn of profile.functions.filter((fn) => !fn.objects)) {
      expect(
        String(policies.find((policy) => policy.RoleName === fn.name)?.PolicyDocument),
      ).not.toContain("s3:");
    }
    const publisherPolicy = String(
      policies.find((policy) => policy.RoleName === `${config.project}-publisher`)?.PolicyDocument,
    );
    expect(publisherPolicy).toContain("publications/*");
    expect(publisherPolicy).not.toContain("s3:DeleteObject");
  });
  it("rejects adoption and foreign late resources before any delete", async () => {
    const collision = fakeClients(({ name }) => {
      if (name === "GetQueueUrlCommand")
        return { QueueUrl: `${config.endpoint}/000000000000/${profile.workers[0]!.queue}` };
      if (name === "ListQueueTagsCommand") return { Tags: { "jawstack:owner": ownerId } };
      return absent();
    });
    await expect(inspectApplication(collision.clients, config)).rejects.toThrow(
      "refusing adoption",
    );
    const late = fakeClients(({ name, input }) => {
      if (name === "GetRoleCommand" && input.RoleName === profile.schedulerRole)
        return { Role: { Tags: [{ Key: "jawstack:owner", Value: "foreign" }] } };
      return absent();
    });
    await expect(inspectApplication(late.clients, config, ownerId)).rejects.toThrow("not owned");
    expect(late.calls.some((call) => /^(Delete|Remove|Update)/.test(call.name))).toBe(false);
  });
  it("discovers unsaved mappings but refuses foreign mappings and schedule targets", async () => {
    const wrongMapping = fakeClients(({ name }) => {
      if (name === "GetFunctionCommand") return { Tags: { "jawstack:owner": ownerId } };
      if (name === "ListEventSourceMappingsCommand")
        return { EventSourceMappings: [{ UUID: "lost-before-save", EventSourceArn: "foreign" }] };
      return absent();
    });
    await expect(inspectApplication(wrongMapping.clients, config, ownerId)).rejects.toThrow(
      "Unexpected application event source",
    );
    const wrongSchedule = fakeClients(({ name }) => {
      if (name === "GetScheduleGroupCommand") return { Arn: "group" };
      if (name === "ListTagsForResourceCommand")
        return { Tags: [{ Key: "jawstack:owner", Value: ownerId }] };
      if (name === "ListSchedulesCommand") return { Schedules: [{ Name: "duePublication" }] };
      if (name === "GetScheduleCommand") return { Target: { Arn: "foreign" } };
      return absent();
    });
    await expect(inspectApplication(wrongSchedule.clients, config, ownerId)).rejects.toThrow(
      "Unexpected application schedule",
    );
    const saved = fakeClients(({ name, input }) => {
      if (name === "GetFunctionCommand" && input.FunctionName === profile.workers[0]!.name)
        return { Tags: { "jawstack:owner": ownerId } };
      if (name === "ListEventSourceMappingsCommand")
        return {
          EventSourceMappings: [
            {
              UUID: "lost-before-save",
              EventSourceArn: `arn:aws:sqs:${config.region}:000000000000:${profile.workers[0]!.queue}`,
            },
          ],
        };
      return absent();
    });
    expect((await inspectApplication(saved.clients, config, ownerId)).mappings).toEqual([
      "lost-before-save",
    ]);
  });
  it("quiesces schedules and mappings before removing owned functions/queues/roles", async () => {
    const h = fakeClients(({ name }) => (name === "GetEventSourceMappingCommand" ? absent() : {}));
    await cleanupApplication(h.clients, config, {
      schedules: ["duePublication"],
      mappings: ["saved-or-discovered"],
      rules: [profile.workers[0]!.rule],
      functions: [profile.jobs],
      logGroups: [`/aws/lambda/${profile.jobs}`],
      queues: [`${config.endpoint}/000000000000/${profile.schedulerDlq}`],
      roles: [profile.jobs],
    });
    expect(h.calls.map((call) => call.name)).toEqual([
      "DeleteScheduleCommand",
      "DeleteEventSourceMappingCommand",
      "GetEventSourceMappingCommand",
      "RemoveTargetsCommand",
      "DeleteRuleCommand",
      "DeleteFunctionCommand",
      "DeleteLogGroupCommand",
      "DeleteQueueCommand",
      "DeleteRolePolicyCommand",
      "DeleteRoleCommand",
    ]);
  });
  it("refuses an undeclared schedule instead of deleting it with the owned group", async () => {
    const h = fakeClients(({ name }) => {
      if (name === "GetScheduleGroupCommand") return { Arn: "owned-group" };
      if (name === "ListTagsForResourceCommand")
        return { Tags: [{ Key: "jawstack:owner", Value: ownerId }] };
      if (name === "ListSchedulesCommand") return { Schedules: [{ Name: "unrelated-schedule" }] };
      return absent();
    });
    await expect(inspectApplication(h.clients, config, ownerId)).rejects.toThrow(
      "Unexpected schedule in owned group",
    );
    expect(h.calls.some((call) => /^(Delete|Remove|Update)/.test(call.name))).toBe(false);
  });
});

describe("local application entrypoint isolation", () => {
  it("requires the exact owned function, stage and consumer before issuing requests", async () => {
    const network = vi.spyOn(NodeHttpHandler.prototype, "handle");
    vi.stubEnv("CONTENT_OPS_LAB_ID", config.instanceId);
    vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "unowned");
    try {
      await expect(publisher({ Records: [] })).rejects.toThrow("local execution context");
      await expect(scheduled({ targetHandler: "duePublication" })).rejects.toThrow(
        "local execution context",
      );
      vi.stubEnv("CONTENT_OPS_CONSUMER", "materializeReview");
      await expect(worker({ Records: [] })).rejects.toThrow("local execution context");
      await expect(collector({ Records: [] })).rejects.toThrow("local execution context");
      vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "");
      vi.stubEnv("AWS_PROFILE", "private-profile");
      expect(() => createClients(config)).toThrow("AWS_PROFILE");
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      network.mockRestore();
    }
  });
  it("allows only the declared role of each entrypoint, with no AWS-mode escape", () => {
    const env = { CONTENT_OPS_LAB_ID: config.instanceId, AWS_LAMBDA_FUNCTION_NAME: profile.jobs };
    expect(localLambdaConfig("jobs", env).endpoint).toBe("http://localstack:4566");
    expect(
      localLambdaConfig("jobs", {
        ...env,
        LOCALSTACK_HOSTNAME: "172.21.0.2",
        AWS_ENDPOINT_URL: "http://172.21.0.2:4566",
      }).endpoint,
    ).toBe("http://localstack:4566");
    for (const extra of [
      { CONTENT_OPS_RUNTIME: "aws" },
      { CONTENT_OPS_STAGE: "production" },
      { AWS_ENDPOINT_URL_DYNAMODB: "https://dynamodb.us-east-1.amazonaws.com" },
      { LOCALSTACK_HOSTNAME: "172.21.0.2", AWS_ENDPOINT_URL: "http://172.21.0.3:4566" },
      { LOCALSTACK_HOSTNAME: "1.2.3.4", AWS_ENDPOINT_URL: "http://1.2.3.4:4566" },
    ])
      expect(() => localLambdaConfig("jobs", { ...env, ...extra })).toThrow();
  });
});
