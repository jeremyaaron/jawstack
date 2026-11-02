import * as ddb from "@aws-sdk/client-dynamodb";
import * as events from "@aws-sdk/client-eventbridge";
import * as iam from "@aws-sdk/client-iam";
import * as lambda from "@aws-sdk/client-lambda";
import * as logs from "@aws-sdk/client-cloudwatch-logs";
import * as sqs from "@aws-sdk/client-sqs";
import * as s3 from "@aws-sdk/client-s3";
import * as scheduler from "@aws-sdk/client-scheduler";
import { isDeepStrictEqual as equal } from "node:util";
import { LabError, type LabManifest } from "./config";
import type { LabClients } from "./clients";
import { missing } from "./lifecycle";
import {
  arn,
  policyDocument,
  queueProperties,
  queueUrl,
  scheduleProperties,
  serviceContext,
  trustDocument,
  functionEnvironment,
  queuePolicy,
} from "./service-plan";

export async function pages<T>(
  request: (cursor?: string) => Promise<{ values: readonly T[]; cursor?: string | undefined }>,
) {
  const values: T[] = [],
    seen = new Set<string>();
  let cursor: string | undefined;
  let count = 0;
  do {
    if (++count > 10 || (cursor && seen.has(cursor)))
      throw new LabError("Listing exceeds the page budget or repeats a cursor.");
    if (cursor) seen.add(cursor);
    const page = await request(cursor);
    values.push(...page.values);
    if (values.length > 10_000) throw new LabError("Listing exceeds the bounded cleanup budget.");
    cursor = page.cursor;
  } while (cursor);
  return values;
}
export function tagRecord(
  tags: readonly { Key?: string | undefined; Value?: string | undefined }[] = [],
) {
  const result: Record<string, string> = Object.create(null);
  for (const tag of tags) {
    if (!tag.Key || tag.Value === undefined || tag.Key in result)
      throw new LabError("Invalid/duplicate ownership tags.");
    result[tag.Key] = tag.Value;
  }
  return result;
}
const json = (value: string | undefined) => {
  try {
    return JSON.parse(value ?? "null") as unknown;
  } catch {
    throw new LabError("Invalid service configuration JSON.");
  }
};
export async function inspectServices(
  c: LabClients,
  manifest: LabManifest,
  mode: "vacant" | "reset" | "ready" = "reset",
) {
  const ctx = serviceContext(manifest),
    { plan: p, tags } = ctx;
  const strict = mode === "ready" || manifest.status === "ready" || manifest.status === "resetting";
  const complete = mode === "ready" || (strict && manifest.status !== "resetting");
  const out = {
    tables: [] as string[],
    buses: [] as string[],
    buckets: [] as { name: string; keys: string[] }[],
    queues: [] as string[],
    roles: [] as string[],
    functions: [] as string[],
    logs: [] as string[],
    mappings: [] as string[],
    rules: [] as { name: string; bus: string; targetId: string }[],
    groups: [] as string[],
    schedules: [] as { name: string; group: string }[],
    streams: {} as Record<string, string>,
  };
  const owned = (actual: Record<string, string> | undefined) => {
    if (mode === "vacant")
      throw new LabError("A named resource already exists; refusing adoption or retagging.");
    if (Object.entries(tags).some(([key, value]) => actual?.[key] !== value))
      throw new LabError("Resource is not owned by this lab/profile; refusing mutation.");
  };
  const match = (valid: boolean) => {
    if (!valid)
      throw new LabError("Unexpected service configuration/target/archive; refusing mutation.");
  };
  for (const t of p.tables) {
    const found = await missing(() =>
      c.dynamo.send(new ddb.DescribeTableCommand({ TableName: t.name })),
    );
    if (!found) continue;
    match(found.Table?.TableArn === arn("table", t.name));
    owned(
      tagRecord(
        await pages(async (cursor) => {
          const r = await c.dynamo.send(
            new ddb.ListTagsOfResourceCommand({
              ResourceArn: arn("table", t.name),
              ...(cursor ? { NextToken: cursor } : {}),
            }),
          );
          return { values: r.Tags ?? [], cursor: r.NextToken };
        }),
      ),
    );
    if (strict)
      match(
        found.Table?.TableStatus === "ACTIVE" &&
          equal(found.Table?.KeySchema, [
            { AttributeName: "PK", KeyType: "HASH" },
            { AttributeName: "SK", KeyType: "RANGE" },
          ]) &&
          found.Table?.StreamSpecification?.StreamViewType === "NEW_AND_OLD_IMAGES" &&
          found.Table.GlobalSecondaryIndexes?.some((i) => i.IndexName === "GSI1") === true,
      );
    if (found.Table?.LatestStreamArn) {
      match(found.Table.LatestStreamArn.startsWith(`${arn("table", t.name)}/stream/`));
      out.streams[t.name] = found.Table.LatestStreamArn;
    }
    out.tables.push(t.name);
  }
  for (const b of p.buses) {
    const found = await missing(() =>
      c.events.send(new events.DescribeEventBusCommand({ Name: b.name })),
    );
    if (!found) continue;
    match(found.Arn === arn("bus", b.name));
    owned(
      tagRecord(
        (await c.events.send(new events.ListTagsForResourceCommand({ ResourceARN: found.Arn! })))
          .Tags,
      ),
    );
    const rules = await pages(async (cursor) => {
      const r = await c.events.send(
        new events.ListRulesCommand({
          EventBusName: b.name,
          ...(cursor ? { NextToken: cursor } : {}),
        }),
      );
      return { values: r.Rules ?? [], cursor: r.NextToken };
    });
    for (const rule of rules) {
      const declared = p.rules.find((r) => r.bus === b.name && r.name === rule.Name);
      match(!!declared && !!rule.Arn);
      if (!declared || !rule.Arn) throw new LabError("Unexpected rule.");
      owned(
        tagRecord(
          (await c.events.send(new events.ListTagsForResourceCommand({ ResourceARN: rule.Arn })))
            .Tags,
        ),
      );
      match(
        equal(json(rule.EventPattern), {
          source: [declared.source],
          "detail-type": declared.eventTypes,
        }),
      );
      const targets = await pages(async (cursor) => {
        const r = await c.events.send(
          new events.ListTargetsByRuleCommand({
            Rule: declared.name,
            EventBusName: b.name,
            ...(cursor ? { NextToken: cursor } : {}),
          }),
        );
        return { values: r.Targets ?? [], cursor: r.NextToken };
      });
      match(
        targets.length <= 1 &&
          targets.every(
            (t) => t.Id === declared.targetId && t.Arn === arn("queue", declared.queue),
          ) &&
          (!complete || targets.length === 1),
      );
      out.rules.push({ name: declared.name, bus: b.name, targetId: declared.targetId });
    }
    if (complete) match(rules.length === p.rules.filter((r) => r.bus === b.name).length);
    out.buses.push(b.name);
  }
  for (const q of p.queues) {
    const found = await missing(() =>
      c.sqs.send(new sqs.GetQueueUrlCommand({ QueueName: q.name })),
    );
    if (!found) continue;
    match(!!found.QueueUrl);
    const url = queueUrl(found.QueueUrl!, q.name);
    owned((await c.sqs.send(new sqs.ListQueueTagsCommand({ QueueUrl: url }))).Tags);
    const actual =
      (
        await c.sqs.send(
          new sqs.GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["All"] }),
        )
      ).Attributes ?? {};
    if (strict) {
      for (const [key, value] of Object.entries(queueProperties(q)))
        match(
          key === "RedrivePolicy"
            ? equal(json(actual.RedrivePolicy), json(value))
            : actual[key as sqs.QueueAttributeName] === value,
        );
      match(q.dlq !== undefined || !actual.RedrivePolicy);
      const rule = p.rules.find((r) => r.queue === q.name);
      match(rule ? equal(json(actual.Policy), queuePolicy(rule)) : !actual.Policy);
      match(actual.QueueArn === arn("queue", q.name));
    }
    out.queues.push(url);
  }
  for (const role of p.roles) {
    const found = await missing(() => c.iam.send(new iam.GetRoleCommand({ RoleName: role.name })));
    if (!found) continue;
    const roleTags = await pages(async (cursor) => {
      const r = await c.iam.send(
        new iam.ListRoleTagsCommand({ RoleName: role.name, ...(cursor ? { Marker: cursor } : {}) }),
      );
      if (r.IsTruncated && !r.Marker) throw new LabError("Missing role tag cursor.");
      return { values: r.Tags ?? [], cursor: r.IsTruncated ? r.Marker : undefined };
    });
    owned(tagRecord(roleTags));
    const policies = await pages(async (cursor) => {
      const r = await c.iam.send(
        new iam.ListRolePoliciesCommand({
          RoleName: role.name,
          ...(cursor ? { Marker: cursor } : {}),
        }),
      );
      if (r.IsTruncated && !r.Marker) throw new LabError("Missing policy cursor.");
      return { values: r.PolicyNames ?? [], cursor: r.IsTruncated ? r.Marker : undefined };
    });
    const attached = await pages(async (cursor) => {
      const r = await c.iam.send(
        new iam.ListAttachedRolePoliciesCommand({
          RoleName: role.name,
          ...(cursor ? { Marker: cursor } : {}),
        }),
      );
      if (r.IsTruncated && !r.Marker) throw new LabError("Missing attached policy cursor.");
      return { values: r.AttachedPolicies ?? [], cursor: r.IsTruncated ? r.Marker : undefined };
    });
    match(!attached.length && policies.every((n) => n === role.policyName));
    if (strict) {
      match(
        equal(
          json(decodeURIComponent(found.Role?.AssumeRolePolicyDocument ?? "")),
          trustDocument(role.service),
        ) &&
          (!complete || policies.length === 1),
      );
      if (policies.length) {
        const policy = await c.iam.send(
          new iam.GetRolePolicyCommand({ RoleName: role.name, PolicyName: role.policyName }),
        );
        match(
          equal(
            json(decodeURIComponent(policy.PolicyDocument ?? "")),
            policyDocument(role.statements),
          ),
        );
      }
    }
    out.roles.push(role.name);
  }
  for (const f of p.functions) {
    const found = await missing(() =>
      c.lambda.send(new lambda.GetFunctionCommand({ FunctionName: f.name })),
    );
    if (found) {
      owned(found.Tags);
      if (strict) {
        const cfg = found.Configuration,
          asset = ctx.profile.functions.find((v) => v.name === f.name)!;
        match(
          cfg?.FunctionName === f.name &&
            cfg.Role === arn("role", f.role) &&
            cfg.Handler === asset.handler &&
            cfg.CodeSha256 === Buffer.from(asset.archive.sha256, "hex").toString("base64") &&
            cfg.Runtime === "nodejs22.x" &&
            equal(cfg.Architectures, [manifest.architecture]) &&
            cfg.Timeout === f.timeout &&
            cfg.MemorySize === f.memory &&
            cfg.State === "Active",
        );
        match(equal(cfg?.Environment?.Variables ?? {}, functionEnvironment(f, ctx)));
        const concurrency = await c.lambda.send(
          new lambda.GetFunctionConcurrencyCommand({ FunctionName: f.name }),
        );
        match(concurrency.ReservedConcurrentExecutions === f.concurrency);
        if (f.failureQueue) {
          const invocation = await c.lambda.send(
            new lambda.GetFunctionEventInvokeConfigCommand({ FunctionName: f.name }),
          );
          match(
            invocation.MaximumRetryAttempts === 0 &&
              invocation.MaximumEventAgeInSeconds === 60 &&
              invocation.DestinationConfig?.OnFailure?.Destination === arn("queue", f.failureQueue),
          );
        }
      }
      const mappings = await pages(async (cursor) => {
        const r = await c.lambda.send(
          new lambda.ListEventSourceMappingsCommand({
            FunctionName: f.name,
            ...(cursor ? { Marker: cursor } : {}),
          }),
        );
        return { values: r.EventSourceMappings ?? [], cursor: r.NextMarker };
      });
      const expected = p.mappings.find((m) => m.functionName === f.name);
      match(mappings.length <= 1 && (!complete || mappings.length === (expected ? 1 : 0)));
      for (const m of mappings) {
        const source =
          expected?.source.kind === "stream"
            ? out.streams[expected.source.name]
            : expected
              ? arn("queue", expected.source.name)
              : undefined;
        match(
          !!m.UUID &&
            !!source &&
            m.EventSourceArn === source &&
            m.FunctionArn === arn("function", f.name),
        );
        if (strict)
          match(
            m.State === "Enabled" &&
              m.BatchSize === expected!.batchSize &&
              (expected!.source.kind !== "queue" ||
                m.ScalingConfig?.MaximumConcurrency === expected!.concurrency),
          );
        out.mappings.push(m.UUID!);
      }
      out.functions.push(f.name);
    }
    const group = `/aws/lambda/${f.name}`;
    const log = await missing(() =>
      c.logs.send(new logs.ListTagsLogGroupCommand({ logGroupName: group })),
    );
    if (log) {
      owned(log.tags);
      if (strict) {
        const groups = await pages(async (cursor) => {
          const r = await c.logs.send(
            new logs.DescribeLogGroupsCommand({
              logGroupNamePrefix: group,
              ...(cursor ? { nextToken: cursor } : {}),
            }),
          );
          return { values: r.logGroups ?? [], cursor: r.nextToken };
        });
        match(groups.some((g) => g.logGroupName === group && g.retentionInDays === 7));
      }
      out.logs.push(group);
    }
  }
  for (const b of p.buckets) {
    const found = await missing(() => c.s3.send(new s3.HeadBucketCommand({ Bucket: b.name })));
    if (!found) continue;
    owned(tagRecord((await c.s3.send(new s3.GetBucketTaggingCommand({ Bucket: b.name }))).TagSet));
    match(!(await c.s3.send(new s3.GetBucketVersioningCommand({ Bucket: b.name }))).Status);
    if (strict) {
      const block = (await c.s3.send(new s3.GetPublicAccessBlockCommand({ Bucket: b.name })))
        .PublicAccessBlockConfiguration;
      match(
        !!block?.BlockPublicAcls &&
          !!block.IgnorePublicAcls &&
          !!block.BlockPublicPolicy &&
          !!block.RestrictPublicBuckets,
      );
      match(
        (await c.s3.send(new s3.GetBucketOwnershipControlsCommand({ Bucket: b.name })))
          .OwnershipControls?.Rules?.[0]?.ObjectOwnership === "BucketOwnerEnforced",
      );
    }
    const objects =
      mode === "reset"
        ? await pages(async (cursor) => {
            const r = await c.s3.send(
              new s3.ListObjectsV2Command({
                Bucket: b.name,
                MaxKeys: 1000,
                ...(cursor ? { ContinuationToken: cursor } : {}),
              }),
            );
            if (r.IsTruncated && !r.NextContinuationToken)
              throw new LabError("Missing object continuation token.");
            return {
              values: r.Contents ?? [],
              cursor: r.IsTruncated ? r.NextContinuationToken : undefined,
            };
          })
        : [];
    match(objects.every((o) => !!o.Key));
    out.buckets.push({ name: b.name, keys: objects.map((o) => o.Key!) });
  }
  for (const group of p.scheduleGroups) {
    const found = await missing(() =>
      c.scheduler.send(new scheduler.GetScheduleGroupCommand({ Name: group.name })),
    );
    if (!found) continue;
    match(found.Arn === arn("group", group.name));
    owned(
      tagRecord(
        (
          await c.scheduler.send(
            new scheduler.ListTagsForResourceCommand({ ResourceArn: found.Arn! }),
          )
        ).Tags,
      ),
    );
    const schedules = await pages(async (cursor) => {
      const r = await c.scheduler.send(
        new scheduler.ListSchedulesCommand({
          GroupName: group.name,
          MaxResults: 100,
          ...(cursor ? { NextToken: cursor } : {}),
        }),
      );
      return { values: r.Schedules ?? [], cursor: r.NextToken };
    });
    for (const item of schedules) {
      const declared = p.schedules.find((s) => s.group === group.name && s.name === item.Name);
      match(!!declared);
      if (!declared) throw new LabError("Unexpected schedule in owned group.");
      const actual = await c.scheduler.send(
          new scheduler.GetScheduleCommand({ Name: declared.name, GroupName: group.name }),
        ),
        target = scheduleProperties(declared).Target;
      // Proof scenarios intentionally toggle input/state; never relax target/role/DLQ/retry identity.
      match(
        actual.Target?.Arn === target.Arn &&
          actual.Target.RoleArn === target.RoleArn &&
          actual.Target.DeadLetterConfig?.Arn === target.DeadLetterConfig?.Arn &&
          actual.Target.RetryPolicy?.MaximumRetryAttempts === 0 &&
          actual.Target.RetryPolicy.MaximumEventAgeInSeconds === 60,
      );
      out.schedules.push({ name: declared.name, group: group.name });
    }
    if (complete)
      match(schedules.length === p.schedules.filter((s) => s.group === group.name).length);
    out.groups.push(group.name);
  }
  if (mode === "ready")
    for (const [actual, expected] of [
      [out.tables.length, p.tables.length],
      [out.buses.length, p.buses.length],
      [out.queues.length, p.queues.length],
      [out.functions.length, p.functions.length],
      [out.roles.length, p.roles.length],
      [out.buckets.length, p.buckets.length],
      [out.groups.length, p.scheduleGroups.length],
      [out.logs.length, p.functions.length],
    ])
      match(actual === expected);
  return out;
}
