import { beforeAll, describe, expect, it, vi } from "vitest";
import { App, Stack, Tags } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { ContentOperationsInfrastructure } from "../../src/infra/stack";
import { contentInfrastructureConfig } from "../../src/infra/config";
import { buildInfrastructure } from "../../scripts/build-infra";
import { synthesisContext } from "../../src/aws/synth/context";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { unzipSync } from "fflate";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Construct } from "constructs";
import { JawStackResourceWorkflowApp } from "@jawstack/aws-cdk";
import { defineWorkflow } from "@jawstack/core";
import { z } from "zod";
import { contentEventSchemas } from "../../src/shared/contracts";
import { parseContentEvent } from "../../src/shared/events";

type Resource = { Type: string; Properties: Record<string, unknown> };
let entrypoints: Awaited<ReturnType<typeof buildInfrastructure>>;
beforeAll(async () => {
  entrypoints = await buildInfrastructure();
}, 30_000);
function synth() {
  const app = new App({ autoSynth: false });
  const stack = new Stack(app, "ContentTest", {
    env: { account: "000000000000", region: "us-east-1" },
  });
  const infrastructure = new ContentOperationsInfrastructure(stack, "Content", { entrypoints });
  const template = Template.fromStack(stack);
  const resources = template.toJSON().Resources as Record<string, Resource>;
  const byType = (type: string) =>
    Object.entries(resources).filter(([, resource]) => resource.Type === type);
  const fn = (name: string) => {
    const entry = byType("AWS::Lambda::Function").find(
      ([, resource]) => resource.Properties.FunctionName === name,
    );
    if (!entry) throw new Error(`Missing synthesized function ${name}`);
    return entry;
  };
  const policy = (name: string) => {
    const [, resource] = fn(name);
    const role = (resource.Properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0];
    return byType("AWS::IAM::Policy")
      .filter(([, item]) =>
        (item.Properties.Roles as { Ref: string }[]).some((binding) => binding.Ref === role),
      )
      .flatMap(
        ([, item]) =>
          (
            item.Properties.PolicyDocument as {
              Statement: { Action: string | string[]; Resource: unknown; Effect: string }[];
            }
          ).Statement,
      );
  };
  return { app, stack, template, resources, byType, fn, policy, infrastructure };
}

describe("content application synthesis", () => {
  it("matches the existing Content collector/queue/log bounds and wiring through the opt-in framework", () => {
    const reference = synth();
    const { config } = reference.infrastructure;
    const definition = defineWorkflow({
      name: "content-operations",
      source: config.lab.source,
      resources: config.resources,
      commands: { idempotencyTtlSeconds: 604800 },
      events: Object.entries(contentEventSchemas).map(([eventType, schema]) => ({
        eventType,
        schemaVersion: 1,
        // Keep core's strict-object contract; the original parser below retains wrapper refinements.
        schema: schema instanceof z.ZodReadonly ? schema.unwrap() : schema,
        validateIdentity: (event) => {
          parseContentEvent(event, config.lab.source);
          return true;
        },
      })),
      consumers: Object.fromEntries(
        config.profile.workers.map((worker) => [
          worker.consumer,
          {
            recovery:
              worker.consumer === "publishContent" ? ("application" as const) : ("replay" as const),
          },
        ]),
      ),
      operations: { resourceType: "contentItem", projection: "contentItem.failures" },
    });
    const stack = new Stack(new App({ autoSynth: false }), "ContentManaged", {
      env: { account: "000000000000", region: "us-east-1" },
    });
    const scope = new Construct(stack, "Content");
    const workflow = new JawStackResourceWorkflowApp(scope, "Workflow", {
      appName: config.appName,
      stage: config.stage,
      resources: config.resources,
      costProfile: config.costProfile,
      auth: config.auth,
      removalPolicy: "destroy",
      recoverableWorkers: { definition, collectorHandler: entrypoints.collector },
      entrypoints: {
        apiHandler: entrypoints.api,
        outboxHandler: entrypoints.outbox,
        workerHandlers: Object.fromEntries(
          config.profile.workers.map((worker) => [worker.consumer, entrypoints.worker]),
        ),
        schedulerHandlers: Object.fromEntries(
          config.profile.schedules.map((job) => [job.targetHandler, entrypoints.scheduler]),
        ),
      },
    });
    Tags.of(scope).add("jawstack:consumer", "content-operations");
    Tags.of(scope).add("jawstack:stage", "local");
    const template = Template.fromStack(stack),
      resources = template.toJSON().Resources as Record<string, Resource>;
    const byType = (type: string) => Object.entries(resources).filter(([, r]) => r.Type === type);
    const identities = (items: Record<string, Resource>) =>
      Object.fromEntries(
        Object.entries(items).map(([id, r]) => [
          id,
          r.Properties.FunctionName ?? r.Properties.QueueName ?? r.Properties.TableName ?? id,
        ]),
      );
    const normalize = (value: unknown, ids: Record<string, unknown>): unknown => {
      if (Array.isArray(value)) return value.map((v) => normalize(v, ids));
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, v]) => [
            key,
            key === "Ref" && typeof v === "string"
              ? (ids[v] ?? v)
              : key === "Fn::GetAtt" && Array.isArray(v)
                ? [ids[v[0]] ?? v[0], v[1]]
                : normalize(v, ids),
          ]),
        );
      return value;
    };
    const oldIds = identities(reference.resources),
      newIds = identities(resources);
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.resourceCountIs("AWS::S3::Bucket", 0);
    expect(Object.keys(workflow.collectorFunctionsByName).sort()).toEqual(
      config.profile.workers.map((worker) => worker.consumer).sort(),
    );
    for (const worker of config.profile.workers) {
      const base = `content-operations-local-${worker.consumer.toLowerCase()}`;
      const old = reference.fn(`${base}-collector`),
        current = byType("AWS::Lambda::Function").find(
          ([, r]) => r.Properties.FunctionName === `${base}-collector`,
        )!;
      for (const key of [
        "FunctionName",
        "Runtime",
        "Architectures",
        "Handler",
        "Timeout",
        "MemorySize",
        "ReservedConcurrentExecutions",
        "DeadLetterConfig",
      ])
        expect(current[1].Properties[key]).toEqual(old[1].Properties[key]);
      expect(workflow.collectorFunctionsByName[worker.consumer]!.node.id).toBe(
        `${worker.consumer}Collector`,
      );
      expect(current[0]).toBe(old[0]); // Content now uses the same opt-in collector composition.
      const vars = (current[1].Properties.Environment as { Variables: Record<string, unknown> })
        .Variables;
      expect(vars).toMatchObject({
        JAWSTACK_WORKER_NAME: worker.consumer,
        JAWSTACK_WORKFLOW_ROLE: "collector",
        JAWSTACK_WORKFLOW_HASH: definition.manifest.hash,
      });
      for (const suffix of ["queue", "dlq"]) {
        const name = `${base}-${suffix}`;
        const before = reference
          .byType("AWS::SQS::Queue")
          .find(([, r]) => r.Properties.QueueName === name)![1];
        const after = byType("AWS::SQS::Queue").find(
          ([, r]) => r.Properties.QueueName === name,
        )![1];
        expect(normalize(after.Properties, newIds)).toEqual(normalize(before.Properties, oldIds));
      }
      const oldMapping = reference
        .byType("AWS::Lambda::EventSourceMapping")
        .find(
          ([, r]) => JSON.stringify(r.Properties.FunctionName) === JSON.stringify({ Ref: old[0] }),
        )![1];
      const newMapping = byType("AWS::Lambda::EventSourceMapping").find(
        ([, r]) =>
          JSON.stringify(r.Properties.FunctionName) === JSON.stringify({ Ref: current[0] }),
      )![1];
      expect(normalize(newMapping.Properties, newIds)).toEqual(
        normalize(oldMapping.Properties, oldIds),
      );
      const logName = `/aws/lambda/${base}-collector`;
      const beforeLog = reference
        .byType("AWS::Logs::LogGroup")
        .find(([, r]) => r.Properties.LogGroupName === logName)![1];
      const afterLog = byType("AWS::Logs::LogGroup").find(
        ([, r]) => r.Properties.LogGroupName === logName,
      )![1];
      expect(afterLog).toMatchObject({ Properties: beforeLog.Properties });
      const role = (current[1].Properties.Role as { "Fn::GetAtt": string[] })["Fn::GetAtt"][0];
      const policies = byType("AWS::IAM::Policy").filter(([, r]) =>
        (r.Properties.Roles as { Ref: string }[]).some((v) => v.Ref === role),
      );
      const statements = policies.flatMap(
        ([, r]) =>
          (
            r.Properties.PolicyDocument as {
              Statement: { Action: string | string[]; Resource: unknown }[];
            }
          ).Statement,
      );
      const actions = statements.flatMap((s) => [s.Action].flat());
      expect(actions.filter((a) => a.startsWith("dynamodb:")).sort()).toEqual(
        [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
          "dynamodb:DescribeTable",
          "dynamodb:ListTagsOfResource",
        ].sort(),
      );
      expect(actions.some((a) => /^(s3|events|scheduler|iam):/.test(a))).toBe(false);
      const oldConsume = reference
        .policy(`${base}-collector`)
        .filter((s) => [s.Action].flat().includes("sqs:ReceiveMessage"));
      const newConsume = statements.filter((s) => [s.Action].flat().includes("sqs:ReceiveMessage"));
      expect(normalize(newConsume, newIds)).toEqual(normalize(oldConsume, oldIds));
    }
  });
  it("uses the lab profile for every declared consumer, due job and transport bound", () => {
    const h = synth();
    const { profile } = h.infrastructure.config;
    h.template.resourceCountIs("AWS::DynamoDB::Table", 1);
    h.template.resourceCountIs("AWS::S3::Bucket", 1);
    h.template.resourceCountIs("AWS::Lambda::Function", 15);
    h.template.resourceCountIs("AWS::SQS::Queue", 13);
    h.template.resourceCountIs("AWS::Scheduler::Schedule", 4);
    h.template.resourceCountIs("AWS::Lambda::EventInvokeConfig", 4);
    h.template.resourceCountIs("AWS::Lambda::EventSourceMapping", 9);
    h.template.resourceCountIs("AWS::Logs::LogGroup", 15);
    for (const [, fn] of h.byType("AWS::Lambda::Function")) {
      expect(fn.Properties).toMatchObject({
        Runtime: "nodejs22.x",
        Architectures: ["arm64"],
        Timeout: profile.bounds.timeout,
        MemorySize: profile.bounds.memory,
      });
      expect(fn.Properties.Environment).toMatchObject({
        Variables: {
          CONTENT_OPS_STAGE: "local",
          CONTENT_OPS_RUNTIME: "localstack",
          CONTENT_OPS_SYNTH_ONLY: "true",
          JAWSTACK_AUTH_MODE: "dev",
          JAWSTACK_AUTH_PROVIDER: "fixtures",
        },
      });
      expect(JSON.stringify(fn.Properties.Environment)).not.toMatch(
        /AUTH_TOKEN|AWS_PROFILE|ACCESS_KEY|ENDPOINT_URL/,
      );
    }
    expect(
      h
        .byType("AWS::Logs::LogGroup")
        .every(
          ([, resource]) => resource.Properties.RetentionInDays === profile.bounds.logRetention,
        ),
    ).toBe(true);
    for (const worker of profile.workers) {
      const base = `content-operations-local-${worker.consumer.toLowerCase()}`;
      h.template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: `${base}-queue`,
        VisibilityTimeout: profile.bounds.visibility,
        MessageRetentionPeriod: profile.bounds.sourceRetention,
        RedrivePolicy: {
          maxReceiveCount: profile.bounds.receives,
          deadLetterTargetArn: Match.anyValue(),
        },
      });
      h.template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: `${base}-dlq`,
        VisibilityTimeout: profile.bounds.visibility,
        MessageRetentionPeriod: profile.bounds.dlqRetention,
      });
      const rule = h
        .byType("AWS::Events::Rule")
        .map(
          ([, r]) =>
            r.Properties.EventPattern as
              | {
                  source?: string[];
                  "detail-type"?: string[];
                }
              | undefined,
        )
        .find((pattern) => pattern?.["detail-type"]?.includes(worker.eventTypes[0]!));
      expect(rule?.source).toEqual([h.infrastructure.config.lab.source]);
      expect([...rule!["detail-type"]!].sort()).toEqual([...worker.eventTypes].sort());
      const [workerId, workerResource] = h.fn(`${base}-worker`);
      const [collectorId, collectorResource] = h.fn(`${base}-collector`);
      for (const [targetId, resource] of [
        [workerId, workerResource],
        [collectorId, collectorResource],
      ] as const) {
        expect(resource.Properties.ReservedConcurrentExecutions).toBe(profile.bounds.concurrency);
        const vars = (resource.Properties.Environment as { Variables: Record<string, unknown> })
          .Variables;
        expect(vars.CONTENT_OPS_CONSUMER).toBe(worker.consumer);
        h.template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
          FunctionName: { Ref: targetId },
          EventSourceArn: vars.CONTENT_OPS_QUEUE_ARN,
          BatchSize: profile.bounds.batchSize,
          ScalingConfig: { MaximumConcurrency: profile.bounds.concurrency },
        });
      }
    }
    for (const job of profile.schedules) {
      const [id] = h.fn(`content-operations-local-${job.name.toLowerCase()}-scheduler`);
      h.template.hasResourceProperties("AWS::Scheduler::Schedule", {
        ScheduleExpression: "rate(1 minute)",
        State: "ENABLED",
        FlexibleTimeWindow: { Mode: "OFF" },
        Target: {
          Arn: { "Fn::GetAtt": [id, "Arn"] },
          Input: JSON.stringify({ scheduleName: job.name, targetHandler: job.targetHandler }),
          RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 },
          DeadLetterConfig: { Arn: Match.anyValue() },
          RoleArn: Match.anyValue(),
        },
      });
      expect(
        h
          .policy(`content-operations-local-${job.name.toLowerCase()}-scheduler`)
          .some((statement) => [statement.Action].flat().includes("dynamodb:PutItem")),
      ).toBe(true);
    }
    h.template.hasResourceProperties("AWS::DynamoDB::Table", {
      StreamSpecification: { StreamViewType: "NEW_AND_OLD_IMAGES" },
      TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
    });
    h.template.hasResourceProperties("AWS::ApiGatewayV2::Api", { ProtocolType: "HTTP" });
  });
  it("keeps private object grants targeted and collectors bounded without a DLQ chain", () => {
    const h = synth();
    h.template.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
      OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    });
    const s3Policy = (name: string) =>
      h
        .policy(name)
        .filter((statement) =>
          [statement.Action].flat().some((action) => action.startsWith("s3:")),
        );
    for (const worker of h.infrastructure.config.profile.workers) {
      const base = `content-operations-local-${worker.consumer.toLowerCase()}`;
      expect(s3Policy(`${base}-collector`)).toEqual([]);
      if (worker.consumer !== "publishContent") expect(s3Policy(`${base}-worker`)).toEqual([]);
    }
    const publisher = s3Policy("content-operations-local-publishcontent-worker");
    expect(JSON.stringify(publisher)).toContain("publications/*");
    expect(JSON.stringify(publisher)).toContain("assets/*");
    expect(JSON.stringify(publisher)).not.toContain("s3:DeleteObject");
    const api = s3Policy("content-operations-local-api");
    const writes = api.filter((statement) => [statement.Action].flat().includes("s3:PutObject"));
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(writes)).toContain("assets/*");
    expect(JSON.stringify(writes)).not.toContain("publications/*");
    for (const job of h.infrastructure.config.profile.schedules) {
      const permissions = s3Policy(`content-operations-local-${job.name.toLowerCase()}-scheduler`);
      if (job.name === "cleanupOrphans") {
        expect(JSON.stringify(permissions)).toContain("s3:DeleteObject");
        expect(JSON.stringify(permissions)).toContain("assets/*");
        expect(JSON.stringify(permissions)).not.toContain("publications/*");
      } else expect(permissions).toEqual([]);
    }
    expect(
      h
        .byType("AWS::Lambda::Function")
        .filter(([, resource]) => String(resource.Properties.FunctionName).endsWith("-collector"))
        .every(([, resource]) => resource.Properties.DeadLetterConfig === undefined),
    ).toBe(true);
    for (const [, resource] of h.byType("AWS::Lambda::EventInvokeConfig"))
      expect(resource.Properties).toMatchObject({
        MaximumRetryAttempts: 0,
        MaximumEventAgeInSeconds: 60,
        DestinationConfig: { OnFailure: { Destination: expect.anything() } },
      });
  });
  it("keeps config and synthesis credential-free while rejecting non-local stages/accounts", () => {
    const network = vi.spyOn(NodeHttpHandler.prototype, "handle");
    vi.stubEnv("AWS_PROFILE", "must-not-load");
    try {
      expect(contentInfrastructureConfig().auth).toEqual({ mode: "dev", provider: "fixtures" });
      synth().app.synth();
      for (const stage of ["dev", "production", "prod"])
        expect(() => contentInfrastructureConfig({ stage })).toThrow("synthesis-only");
      expect(() => contentInfrastructureConfig({ runtime: "aws" })).toThrow();
      const stack = new Stack(new App({ autoSynth: false }), "Cloud", {
        env: { account: "123456789012", region: "us-east-1" },
      });
      expect(() => new ContentOperationsInfrastructure(stack, "Content", { entrypoints })).toThrow(
        "dummy local account",
      );
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      network.mockRestore();
    }
  });
  it("builds/imports every real synthesis handler without runtime initialization", async () => {
    const dir = await mkdtemp(join(tmpdir(), "content-synth-"));
    try {
      let runtime: Uint8Array | undefined;
      const imports: { url: string; names: string[] }[] = [];
      for (const [name, path] of Object.entries(entrypoints)) {
        const contents = unzipSync(await readFile(path));
        expect(Object.keys(contents).sort()).toEqual(["index.mjs", "runtime.mjs"]);
        if (runtime)
          expect(Buffer.from(contents["runtime.mjs"]!).equals(Buffer.from(runtime))).toBe(true);
        else {
          runtime = contents["runtime.mjs"]!;
          await writeFile(join(dir, "runtime.mjs"), runtime);
        }
        await writeFile(join(dir, `${name}.mjs`), contents["index.mjs"]!);
        const url = pathToFileURL(join(dir, `${name}.mjs`)).href;
        const names = name === "outbox" ? ["dispatcher", "sweeper"] : ["handler"];
        imports.push({ url, names });
      }
      const result = await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `for (const entry of ${JSON.stringify(imports)}) { const api = await import(entry.url); for (const name of entry.names) if (typeof api[name] !== "function") throw new Error("Missing handler"); }`,
        ],
        { timeout: 10_000, env: { PATH: process.env.PATH, AWS_PROFILE: "must-not-load" } },
      );
      expect(result.stdout).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("refuses default cloud invocation contexts before any SDK request", async () => {
    const network = vi.spyOn(NodeHttpHandler.prototype, "handle");
    const { api, worker, collector, scheduled, dispatcher, sweeper } =
      await import("../../src/aws/synth/entrypoints");
    try {
      for (const invoke of [
        () => api({}),
        () => worker({ Records: [] }),
        () => collector({ Records: [] }),
        () => scheduled({ targetHandler: "duePublication" }),
        () => dispatcher({ Records: [] }),
        () => sweeper(),
      ])
        await expect(
          Promise.resolve().then(async () => {
            await invoke();
          }),
        ).rejects.toThrow();
      expect(() =>
        synthesisContext("api", { CONTENT_OPS_LAB_ID: "dev", CONTENT_OPS_STAGE: "production" }),
      ).toThrow();
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });
});
