import * as ddb from "@aws-sdk/client-dynamodb";
import * as events from "@aws-sdk/client-eventbridge";
import * as iam from "@aws-sdk/client-iam";
import * as lambda from "@aws-sdk/client-lambda";
import * as logs from "@aws-sdk/client-cloudwatch-logs";
import * as sqs from "@aws-sdk/client-sqs";
import * as s3 from "@aws-sdk/client-s3";
import * as scheduler from "@aws-sdk/client-scheduler";
import { readFile } from "node:fs/promises";
import { LabError, type LabManifest } from "./config";
import type { LabClients } from "./clients";
import { missing, waitFor } from "./lifecycle";
import { verifyArchives, sha256 } from "./profile";
import {
  arn,
  policyDocument,
  queueProperties,
  queueUrl,
  scheduleProperties,
  serviceContext,
  tableProperties,
  trustDocument,
  functionEnvironment,
} from "./service-plan";
import { inspectServices } from "./preflight";

export async function provisionServices(
  c: LabClients,
  manifest: LabManifest,
  save: () => Promise<void>,
) {
  const context = serviceContext(manifest);
  const { profile, plan: p, tags, architecture } = context;
  if (manifest.status !== "starting")
    throw new LabError("Lab already or partially provisioned; use ownership-checked reset first.");
  await verifyArchives(profile);
  // Capture and verify all ZIP bytes before the first remote mutation, not one file per create.
  const archives = new Map<string, Uint8Array>();
  for (const f of profile.functions) {
    const bytes = await readFile(f.archive.path);
    if (sha256(bytes) !== f.archive.sha256)
      throw new LabError("Archive changed before provisioning.");
    archives.set(f.name, bytes);
  }
  await inspectServices(c, manifest, "vacant");
  manifest.status = "provisioning";
  await save();
  const tagList = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
  for (const b of p.buckets) {
    await c.s3.send(new s3.CreateBucketCommand({ Bucket: b.name }));
    await c.s3.send(
      new s3.PutBucketTaggingCommand({ Bucket: b.name, Tagging: { TagSet: tagList } }),
    );
    await c.s3.send(
      new s3.PutBucketOwnershipControlsCommand({
        Bucket: b.name,
        OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
      }),
    );
    await c.s3.send(
      new s3.PutPublicAccessBlockCommand({
        Bucket: b.name,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      }),
    );
  }
  for (const t of p.tables) {
    await c.dynamo.send(
      new ddb.CreateTableCommand({ TableName: t.name, ...tableProperties(), Tags: tagList }),
    );
    const table = await waitFor("table/stream readiness", async () => {
      const r = await c.dynamo.send(new ddb.DescribeTableCommand({ TableName: t.name }));
      return r.Table?.TableStatus === "ACTIVE" && r.Table.LatestStreamArn ? r.Table : undefined;
    });
    if (p.tables[0] === t) manifest.streamArn = table.LatestStreamArn!;
    await save();
  }
  for (const b of p.buses)
    await c.events.send(new events.CreateEventBusCommand({ Name: b.name, Tags: tagList }));
  for (const q of [...p.queues.filter((q) => !q.dlq), ...p.queues.filter((q) => q.dlq)]) {
    const r = await c.sqs.send(
      new sqs.CreateQueueCommand({ QueueName: q.name, tags, Attributes: queueProperties(q) }),
    );
    if (!r.QueueUrl) throw new LabError("Missing created queue URL.");
    queueUrl(r.QueueUrl, q.name);
    if (!manifest.queueUrl && q.dlq) {
      manifest.queueUrl = queueUrl(r.QueueUrl, q.name);
      await save();
    }
  }
  for (const role of p.roles) {
    await c.iam.send(
      new iam.CreateRoleCommand({
        RoleName: role.name,
        Tags: tagList,
        AssumeRolePolicyDocument: JSON.stringify(trustDocument(role.service)),
      }),
    );
    await c.iam.send(
      new iam.PutRolePolicyCommand({
        RoleName: role.name,
        PolicyName: role.policyName,
        PolicyDocument: JSON.stringify(policyDocument(role.statements)),
      }),
    );
  }
  for (const f of p.functions) {
    const entry = profile.functions.find((e) => e.name === f.name)!;
    await c.logs.send(
      new logs.CreateLogGroupCommand({ logGroupName: `/aws/lambda/${f.name}`, tags }),
    );
    await c.logs.send(
      new logs.PutRetentionPolicyCommand({
        logGroupName: `/aws/lambda/${f.name}`,
        retentionInDays: 7,
      }),
    );
    await c.lambda.send(
      new lambda.CreateFunctionCommand({
        FunctionName: f.name,
        Runtime: "nodejs22.x",
        Architectures: [architecture],
        Role: arn("role", f.role),
        Handler: entry.handler,
        Code: { ZipFile: archives.get(f.name)! },
        Timeout: f.timeout,
        MemorySize: f.memory,
        Tags: tags,
        Environment: {
          Variables: functionEnvironment(f, context),
        },
      }),
    );
    await waitFor("Lambda readiness", async () => {
      const r = await c.lambda.send(new lambda.GetFunctionCommand({ FunctionName: f.name }));
      if (r.Configuration?.State === "Failed")
        throw new LabError("Lambda failed to start; inspect owned local logs.");
      return r.Configuration?.State === "Active" ? true : undefined;
    });
    await c.lambda.send(
      new lambda.PutFunctionConcurrencyCommand({
        FunctionName: f.name,
        ReservedConcurrentExecutions: f.concurrency,
      }),
    );
    if (f.failureQueue)
      await c.lambda.send(
        new lambda.PutFunctionEventInvokeConfigCommand({
          FunctionName: f.name,
          MaximumRetryAttempts: 0,
          MaximumEventAgeInSeconds: 60,
          DestinationConfig: { OnFailure: { Destination: arn("queue", f.failureQueue) } },
        }),
      );
  }
  for (const r of p.rules) {
    const q = await c.sqs.send(new sqs.GetQueueUrlCommand({ QueueName: r.queue }));
    await c.sqs.send(
      new sqs.SetQueueAttributesCommand({
        QueueUrl: queueUrl(q.QueueUrl!, r.queue),
        Attributes: {
          Policy: JSON.stringify({
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
          }),
        },
      }),
    );
    await c.events.send(
      new events.PutRuleCommand({
        Name: r.name,
        EventBusName: r.bus,
        EventPattern: JSON.stringify({ source: [r.source], "detail-type": r.eventTypes }),
        Tags: tagList,
      }),
    );
    const result = await c.events.send(
      new events.PutTargetsCommand({
        Rule: r.name,
        EventBusName: r.bus,
        Targets: [{ Id: r.targetId, Arn: arn("queue", r.queue) }],
      }),
    );
    if (result.FailedEntryCount) throw new LabError("Failed to attach a declared event target.");
  }
  for (const m of p.mappings) {
    const source =
      m.source.kind === "queue"
        ? arn("queue", m.source.name)
        : (await c.dynamo.send(new ddb.DescribeTableCommand({ TableName: m.source.name }))).Table
            ?.LatestStreamArn;
    if (!source) throw new LabError("Missing declared mapping source.");
    const result = await c.lambda.send(
      new lambda.CreateEventSourceMappingCommand({
        FunctionName: m.functionName,
        EventSourceArn: source,
        BatchSize: m.batchSize,
        ...(m.source.kind === "stream"
          ? { StartingPosition: "TRIM_HORIZON" }
          : { ScalingConfig: { MaximumConcurrency: m.concurrency! } }),
      }),
    );
    if (!result.UUID) throw new LabError("Missing created mapping identity.");
    manifest.mappings.push(result.UUID);
    await save();
    await waitFor("mapping readiness", async () => {
      const r = await c.lambda.send(
        new lambda.GetEventSourceMappingCommand({ UUID: result.UUID! }),
      );
      if (r.State === "Failed") throw new LabError("Mapping failed.");
      return r.State === "Enabled" ? true : undefined;
    });
  }
  for (const g of p.scheduleGroups)
    await c.scheduler.send(
      new scheduler.CreateScheduleGroupCommand({ Name: g.name, Tags: tagList }),
    );
  // Schedules start only after every function, source and collector mapping is ready.
  for (const s of p.schedules)
    await c.scheduler.send(new scheduler.CreateScheduleCommand(scheduleProperties(s)));
  await inspectServices(c, manifest, "ready");
  manifest.status = "ready";
  await save();
}
export async function resetServices(
  c: LabClients,
  manifest: LabManifest,
  save: () => Promise<void> = async () => {},
) {
  const { plan: p } = serviceContext(manifest);
  const owned = await inspectServices(c, manifest, "reset");
  if (manifest.status === "ready") manifest.status = "resetting";
  await save();
  for (const s of owned.schedules)
    await c.scheduler.send(
      new scheduler.DeleteScheduleCommand({ Name: s.name, GroupName: s.group }),
    );
  for (const UUID of owned.mappings) {
    await missing(() => c.lambda.send(new lambda.DeleteEventSourceMappingCommand({ UUID })));
    await waitFor("mapping deletion", async () =>
      (await missing(() => c.lambda.send(new lambda.GetEventSourceMappingCommand({ UUID }))))
        ? undefined
        : true,
    );
  }
  for (const r of owned.rules) {
    const result = await c.events.send(
      new events.RemoveTargetsCommand({ Rule: r.name, EventBusName: r.bus, Ids: [r.targetId] }),
    );
    if (result.FailedEntryCount) throw new LabError("Event target removal failed.");
    await c.events.send(new events.DeleteRuleCommand({ Name: r.name, EventBusName: r.bus }));
  }
  for (const FunctionName of owned.functions)
    await c.lambda.send(new lambda.DeleteFunctionCommand({ FunctionName }));
  for (const logGroupName of owned.logs)
    await c.logs.send(new logs.DeleteLogGroupCommand({ logGroupName }));
  const sourceQueue = (url: string) =>
    !!p.queues.find((q) => q.name === url.split("/").at(-1))?.dlq;
  for (const QueueUrl of [...owned.queues].sort(
    (a, b) => Number(sourceQueue(b)) - Number(sourceQueue(a)),
  ))
    await c.sqs.send(new sqs.DeleteQueueCommand({ QueueUrl }));
  for (const name of owned.groups) {
    await c.scheduler.send(new scheduler.DeleteScheduleGroupCommand({ Name: name }));
    await waitFor("schedule group deletion", async () =>
      (await missing(() => c.scheduler.send(new scheduler.GetScheduleGroupCommand({ Name: name }))))
        ? undefined
        : true,
    );
  }
  for (const b of owned.buckets) {
    for (let i = 0; i < b.keys.length; i += 1000) {
      const r = await c.s3.send(
        new s3.DeleteObjectsCommand({
          Bucket: b.name,
          Delete: { Objects: b.keys.slice(i, i + 1000).map((Key) => ({ Key })) },
        }),
      );
      if (r.Errors?.length) throw new LabError("Object cleanup failed; manifest retained.");
    }
    await c.s3.send(new s3.DeleteBucketCommand({ Bucket: b.name }));
  }
  for (const name of owned.buses)
    await c.events.send(new events.DeleteEventBusCommand({ Name: name }));
  for (const TableName of owned.tables) {
    await c.dynamo.send(new ddb.DeleteTableCommand({ TableName }));
    await waitFor("table deletion", async () =>
      (await missing(() => c.dynamo.send(new ddb.DescribeTableCommand({ TableName }))))
        ? undefined
        : true,
    );
  }
  for (const RoleName of owned.roles) {
    await missing(() =>
      c.iam.send(
        new iam.DeleteRolePolicyCommand({
          RoleName,
          PolicyName: p.roles.find((r) => r.name === RoleName)!.policyName,
        }),
      ),
    );
    await c.iam.send(new iam.DeleteRoleCommand({ RoleName }));
  }
  await inspectServices(c, manifest, "vacant");
}
