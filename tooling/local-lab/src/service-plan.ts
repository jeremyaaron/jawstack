import { isDeepStrictEqual } from "node:util";
import { LabError, parseProfile, type LabManifest, type LabProfile } from "./config";
import { profileHash } from "./profile";
import type { ServicePlan } from "./services-schema";
import { currentManifestSchema } from "./config";
import { copyWorkflowJson } from "@jawstack/core";

export const arn = (
  service: "queue" | "function" | "role" | "table" | "bus" | "log" | "group",
  name: string,
) =>
  ({
    queue: `arn:aws:sqs:us-east-1:000000000000:${name}`,
    function: `arn:aws:lambda:us-east-1:000000000000:function:${name}`,
    role: `arn:aws:iam::000000000000:role/${name}`,
    table: `arn:aws:dynamodb:us-east-1:000000000000:table/${name}`,
    bus: `arn:aws:events:us-east-1:000000000000:event-bus/${name}`,
    log: `arn:aws:logs:us-east-1:000000000000:log-group:/aws/lambda/${name}:*`,
    group: `arn:aws:scheduler:us-east-1:000000000000:schedule-group/${name}`,
  })[service];
export function queueUrl(value: string, name: string) {
  if (
    !["http://127.0.0.1:4566", "http://localstack:4566"].some(
      (origin) => value === `${origin}/000000000000/${name}`,
    )
  )
    throw new LabError("Unsafe queue URL returned by the emulator.");
  return `http://127.0.0.1:4566/000000000000/${name}`;
}
export function serviceContext(input: LabManifest) {
  try {
    input = currentManifestSchema.parse(copyWorkflowJson(input, 256 * 1024));
  } catch {
    throw new LabError("Only current owned service manifests can provision/reset.");
  }
  if (
    input.schemaVersion !== 2 ||
    profileHash(input.profile) !== input.profileHash ||
    input.instanceId !== input.profile.instanceId ||
    !/^[a-f0-9-]{36}$/.test(input.ownerId)
  )
    throw new LabError("Only current owned service manifests can provision/reset.");
  const profile = parseProfile(input.profile);
  const plan = profile.services;
  if (!plan)
    throw new LabError(
      "This lifecycle-only profile has no finite service plan; owned down/recreation required.",
    );
  validateServices(profile, plan);
  return {
    profile,
    plan,
    ownerId: input.ownerId,
    profileHash: input.profileHash,
    architecture: input.architecture,
    tags: {
      "jawstack:owner": input.ownerId,
      "jawstack:lab": plan.workflowHash ? profile.instanceId : profile.project,
      "jawstack:profile": input.profileHash,
      ...(plan.workflowHash ? { "jawstack:workflow": plan.workflowHash } : {}),
    },
  };
}
function validateServices(p: LabProfile, s: ServicePlan) {
  const fail = () => {
    throw new LabError("Invalid finite service references, bounds or grants.");
  };
  for (const key of ["tables", "buses", "queues", "roles", "buckets", "scheduleGroups"] as const) {
    const actual = s[key].map((r) => r.name).sort();
    if (!isDeepStrictEqual(actual, [...p.resources[key]].sort())) fail();
  }
  if (
    !isDeepStrictEqual(s.functions.map((f) => f.name).sort(), p.functions.map((f) => f.name).sort())
  )
    fail();
  const has = (key: keyof LabProfile["resources"], name: string | undefined) =>
    name !== undefined && p.resources[key].includes(name);
  const functions = new Set(s.functions.map((f) => f.name));
  for (const q of s.queues)
    if (
      (q.dlq &&
        (!has("queues", q.dlq) ||
          q.dlq === q.name ||
          s.queues.find((v) => v.name === q.dlq)?.dlq)) ||
      !!q.dlq !== !!q.receives
    )
      fail();
  for (const f of s.functions)
    if (
      !has("roles", f.role) ||
      s.roles.find((r) => r.name === f.role)?.service !== "lambda.amazonaws.com" ||
      (f.failureQueue && !has("queues", f.failureQueue)) ||
      Object.keys(f.environment).some((k) =>
        /(^AWS_|^LOCALSTACK_|TOKEN|CREDENTIAL|SECRET|ACCESS_KEY|ENDPOINT|PROFILE)/.test(k),
      ) ||
      (f.ownerEnvironmentKey &&
        (f.ownerEnvironmentKey in f.environment ||
          /AWS_|TOKEN|SECRET|KEY/.test(f.ownerEnvironmentKey))) ||
      (f.profileEnvironmentKey &&
        (f.profileEnvironmentKey in f.environment ||
          f.profileEnvironmentKey === f.ownerEnvironmentKey ||
          /AWS_|TOKEN|SECRET|KEY/.test(f.profileEnvironmentKey)))
    )
      fail();
  const identifiers = new Set<string>();
  if (s.buckets.some((b) => !/^[a-z][a-z0-9-]{2,62}$/.test(b.name))) fail();
  for (const r of s.rules) {
    const key = `${r.bus}/${r.name}`;
    if (identifiers.has(key) || !has("buses", r.bus) || !has("queues", r.queue)) fail();
    identifiers.add(key);
    if (s.rules.filter((other) => other.queue === r.queue).length !== 1) fail();
  }
  for (const m of s.mappings) {
    const key = `mapping/${m.functionName}`;
    if (
      identifiers.has(key) ||
      !functions.has(m.functionName) ||
      !has(m.source.kind === "queue" ? "queues" : "tables", m.source.name) ||
      (m.source.kind === "queue" && (m.batchSize !== 1 || m.concurrency !== 2))
    )
      fail();
    identifiers.add(key);
    if (
      m.source.kind === "queue" &&
      s.queues.find((q) => q.name === m.source.name)!.visibility <
        6 * s.functions.find((f) => f.name === m.functionName)!.timeout
    )
      fail();
  }
  for (const schedule of s.schedules) {
    const key = `schedule/${schedule.group}/${schedule.name}`;
    if (
      identifiers.has(key) ||
      !has("scheduleGroups", schedule.group) ||
      !functions.has(schedule.functionName) ||
      !has("roles", schedule.role) ||
      s.roles.find((r) => r.name === schedule.role)?.service !== "scheduler.amazonaws.com" ||
      (schedule.failureQueue && !has("queues", schedule.failureQueue))
    )
      fail();
    identifiers.add(key);
  }
  const exact = new Set([
    ...s.tables.flatMap((t) => [
      arn("table", t.name),
      `${arn("table", t.name)}/index/*`,
      `${arn("table", t.name)}/stream/*`,
    ]),
    ...s.buses.map((b) => arn("bus", b.name)),
    ...s.queues.map((q) => arn("queue", q.name)),
    ...s.functions.flatMap((f) => [arn("function", f.name), arn("log", f.name)]),
    ...s.buckets.map((b) => `arn:aws:s3:::${b.name}`),
  ]);
  for (const role of s.roles)
    for (const statement of role.statements)
      for (const resource of statement.resources) {
        const bucketObject = s.buckets.some(
          (b) =>
            resource.startsWith(`arn:aws:s3:::${b.name}/`) &&
            /^[A-Za-z0-9/_-]+\*$/.test(resource.slice(`arn:aws:s3:::${b.name}/`.length)),
        );
        if (!exact.has(resource) && !bucketObject) fail();
        const service = resource.split(":")[2];
        if (statement.actions.some((action) => action.split(":")[0] !== service)) fail();
      }
}
export const policyDocument = (statements: ServicePlan["roles"][number]["statements"]) => ({
  Version: "2012-10-17",
  Statement: statements.map((s) => ({ Effect: "Allow", Action: s.actions, Resource: s.resources })),
});
export const trustDocument = (service: string) => ({
  Version: "2012-10-17",
  Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }],
});
export const functionEnvironment = (
  f: ServicePlan["functions"][number],
  context: { ownerId: string; profileHash: string },
) => ({
  ...f.environment,
  ...(f.ownerEnvironmentKey ? { [f.ownerEnvironmentKey]: context.ownerId } : {}),
  ...(f.profileEnvironmentKey ? { [f.profileEnvironmentKey]: context.profileHash } : {}),
});
export const queuePolicy = (r: ServicePlan["rules"][number]) => ({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "events.amazonaws.com" },
      Action: "sqs:SendMessage",
      Resource: arn("queue", r.queue),
      Condition: {
        ArnEquals: {
          "aws:SourceArn": `arn:aws:events:us-east-1:000000000000:rule/${r.bus}/${r.name}`,
        },
      },
    },
  ],
});
export const tableProperties = () => ({
  BillingMode: "PAY_PER_REQUEST" as const,
  AttributeDefinitions: ["PK", "SK", "GSI1PK", "GSI1SK"].map((AttributeName) => ({
    AttributeName,
    AttributeType: "S" as const,
  })),
  KeySchema: [
    { AttributeName: "PK", KeyType: "HASH" as const },
    { AttributeName: "SK", KeyType: "RANGE" as const },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: "GSI1",
      KeySchema: [
        { AttributeName: "GSI1PK", KeyType: "HASH" as const },
        { AttributeName: "GSI1SK", KeyType: "RANGE" as const },
      ],
      Projection: { ProjectionType: "ALL" as const },
    },
  ],
  StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" as const },
});
export const queueProperties = (q: ServicePlan["queues"][number]) => ({
  VisibilityTimeout: String(q.visibility),
  MessageRetentionPeriod: String(q.retention),
  ...(q.dlq
    ? {
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: arn("queue", q.dlq),
          maxReceiveCount: String(q.receives),
        }),
      }
    : {}),
});
export const scheduleProperties = (s: ServicePlan["schedules"][number]) => ({
  Name: s.name,
  GroupName: s.group,
  ScheduleExpression: "rate(1 minute)",
  FlexibleTimeWindow: { Mode: "OFF" as const },
  State: s.enabled ? ("ENABLED" as const) : ("DISABLED" as const),
  Target: {
    Arn: arn("function", s.functionName),
    RoleArn: arn("role", s.role),
    Input: JSON.stringify(s.input),
    RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 },
    ...(s.failureQueue ? { DeadLetterConfig: { Arn: arn("queue", s.failureQueue) } } : {}),
  },
});
