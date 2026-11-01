import * as events from "@aws-sdk/client-eventbridge";
import * as iam from "@aws-sdk/client-iam";
import * as lambda from "@aws-sdk/client-lambda";
import * as logs from "@aws-sdk/client-cloudwatch-logs";
import * as scheduler from "@aws-sdk/client-scheduler";
import * as sqs from "@aws-sdk/client-sqs";
import { readFile } from "node:fs/promises";
import { applicationProfile } from "../aws/profile";
import { assertOwned, LabError, localQueueUrl, type LabConfig, type LabManifest } from "./config";
import type { LabClients } from "./clients";
import { functionArn, queueArn } from "./capabilities";
import { missing, waitFor } from "./lifecycle";

const tagRecord = (tags: { Key?: string | undefined; Value?: string | undefined }[] = []) =>
  Object.fromEntries(tags.map((tag) => [tag.Key!, tag.Value!]));
const roleArn = (name: string) => `arn:aws:iam::000000000000:role/${name}`;
const assumeRole = (service: string) =>
  JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: service }, Action: "sts:AssumeRole" }],
  });

// Inventory exact declared names even after a crash between an SDK create and manifest save.
export async function inspectApplication(c: LabClients, config: LabConfig, ownerId?: string) {
  const profile = applicationProfile(config);
  const functions: string[] = [];
  const logGroups: string[] = [];
  const roles: string[] = [];
  const queues: string[] = [];
  const rules: string[] = [];
  const schedules: string[] = [];
  const mappings: string[] = [];
  const owned = (tags: Record<string, string> | undefined) => {
    if (!ownerId) throw new LabError("An application resource already exists; refusing adoption.");
    assertOwned(tags, ownerId);
  };
  for (const fn of profile.functions) {
    const found = await missing(() =>
      c.lambda.send(new lambda.GetFunctionCommand({ FunctionName: fn.name })),
    );
    if (found) {
      owned(found.Tags);
      functions.push(fn.name);
      const page = await c.lambda.send(
        new lambda.ListEventSourceMappingsCommand({ FunctionName: fn.name }),
      );
      if (page.NextMarker) throw new LabError("Unexpected application mapping pagination.");
      for (const mapping of page.EventSourceMappings ?? []) {
        if (!fn.queue || !mapping.UUID || mapping.EventSourceArn !== queueArn(config, fn.queue))
          throw new LabError("Unexpected application event source mapping; refusing cleanup.");
        mappings.push(mapping.UUID);
      }
    }
    const log = await missing(() =>
      c.logs.send(new logs.ListTagsLogGroupCommand({ logGroupName: `/aws/lambda/${fn.name}` })),
    );
    if (log) {
      owned(log.tags);
      logGroups.push(`/aws/lambda/${fn.name}`);
    }
  }
  for (const name of [...profile.functions.map((fn) => fn.name), profile.schedulerRole]) {
    const role = await missing(() => c.iam.send(new iam.GetRoleCommand({ RoleName: name })));
    if (role) {
      owned(tagRecord(role.Role?.Tags));
      roles.push(name);
    }
  }
  for (const name of [
    ...profile.workers.flatMap((worker) => [worker.queue, worker.dlq]),
    profile.schedulerDlq,
  ]) {
    const queue = await missing(() => c.sqs.send(new sqs.GetQueueUrlCommand({ QueueName: name })));
    if (queue?.QueueUrl) {
      const url = localQueueUrl(queue.QueueUrl, config, name);
      owned((await c.sqs.send(new sqs.ListQueueTagsCommand({ QueueUrl: url }))).Tags);
      queues.push(url);
    }
  }
  for (const worker of profile.workers) {
    const rule = await missing(() =>
      c.events.send(
        new events.DescribeRuleCommand({ Name: worker.rule, EventBusName: config.bus }),
      ),
    );
    if (rule?.Arn) {
      owned(
        tagRecord(
          (await c.events.send(new events.ListTagsForResourceCommand({ ResourceARN: rule.Arn })))
            .Tags,
        ),
      );
      const targets = await c.events.send(
        new events.ListTargetsByRuleCommand({ Rule: worker.rule, EventBusName: config.bus }),
      );
      if (
        targets.NextToken ||
        targets.Targets?.some(
          (target) => target.Id !== "consumer" || target.Arn !== queueArn(config, worker.queue),
        )
      )
        throw new LabError("Unexpected application event target; refusing cleanup.");
      rules.push(worker.rule);
    }
  }
  const group = await missing(() =>
    c.scheduler.send(new scheduler.GetScheduleGroupCommand({ Name: config.scheduleGroup })),
  );
  if (group?.Arn) {
    owned(
      tagRecord(
        (
          await c.scheduler.send(
            new scheduler.ListTagsForResourceCommand({ ResourceArn: group.Arn }),
          )
        ).Tags,
      ),
    );
    const listed = await c.scheduler.send(
      new scheduler.ListSchedulesCommand({ GroupName: config.scheduleGroup, MaxResults: 100 }),
    );
    const declared: readonly string[] = [
      config.schedule,
      ...profile.schedules.map((item) => item.name),
    ];
    if (
      listed.NextToken ||
      listed.Schedules?.some((item) => !item.Name || !declared.includes(item.Name))
    )
      throw new LabError("Unexpected schedule in owned group; refusing group cleanup.");
    for (const item of profile.schedules) {
      const schedule = await missing(() =>
        c.scheduler.send(
          new scheduler.GetScheduleCommand({ Name: item.name, GroupName: config.scheduleGroup }),
        ),
      );
      if (schedule) {
        if (
          schedule.Target?.Arn !== functionArn(config, profile.jobs) ||
          schedule.Target.RoleArn !== roleArn(profile.schedulerRole)
        )
          throw new LabError("Unexpected application schedule target; refusing cleanup.");
        schedules.push(item.name);
      }
    }
  }
  return { functions, logGroups, roles, queues, rules, schedules, mappings };
}

export async function provisionApplication(
  c: LabClients,
  config: LabConfig,
  manifest: LabManifest,
  save: () => Promise<void>,
) {
  const profile = applicationProfile(config);
  const tags = { "jawstack:owner": manifest.ownerId };
  const tagList = [{ Key: "jawstack:owner", Value: manifest.ownerId }];
  const tableArn = `arn:aws:dynamodb:${config.region}:000000000000:table/${config.table}`;
  const bucketArn = `arn:aws:s3:::${config.bucket}`;
  const createQueue = (name: string, dlq?: string) =>
    c.sqs.send(
      new sqs.CreateQueueCommand({
        QueueName: name,
        tags,
        Attributes: {
          VisibilityTimeout: String(profile.bounds.visibility),
          MessageRetentionPeriod: String(
            dlq ? profile.bounds.sourceRetention : profile.bounds.dlqRetention,
          ),
          ...(dlq
            ? {
                RedrivePolicy: JSON.stringify({
                  deadLetterTargetArn: queueArn(config, dlq),
                  maxReceiveCount: String(profile.bounds.receives),
                }),
              }
            : {}),
        },
      }),
    );
  await createQueue(profile.schedulerDlq);
  for (const worker of profile.workers) {
    await createQueue(worker.dlq);
    const queue = await createQueue(worker.queue, worker.dlq);
    if (!queue.QueueUrl) throw new LabError("Missing application queue URL.");
    await c.sqs.send(
      new sqs.SetQueueAttributesCommand({
        QueueUrl: localQueueUrl(queue.QueueUrl, config, worker.queue),
        Attributes: {
          Policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "events.amazonaws.com" },
                Action: "sqs:SendMessage",
                Resource: queueArn(config, worker.queue),
                Condition: {
                  ArnEquals: {
                    "aws:SourceArn": `arn:aws:events:${config.region}:000000000000:rule/${config.bus}/${worker.rule}`,
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
        Name: worker.rule,
        EventBusName: config.bus,
        Tags: tagList,
        EventPattern: JSON.stringify({ source: [config.source], "detail-type": worker.eventTypes }),
      }),
    );
    const result = await c.events.send(
      new events.PutTargetsCommand({
        Rule: worker.rule,
        EventBusName: config.bus,
        Targets: [{ Id: "consumer", Arn: queueArn(config, worker.queue) }],
      }),
    );
    if (result.FailedEntryCount)
      throw new LabError("Failed to attach an application event target.");
  }
  for (const fn of profile.functions) {
    await c.iam.send(
      new iam.CreateRoleCommand({
        RoleName: fn.name,
        Tags: tagList,
        AssumeRolePolicyDocument: assumeRole("lambda.amazonaws.com"),
      }),
    );
    const statements = [
      {
        Effect: "Allow",
        Action: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:TransactWriteItems",
          "dynamodb:Query",
        ],
        Resource: [tableArn, `${tableArn}/index/*`],
      },
      {
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: `arn:aws:logs:${config.region}:000000000000:log-group:/aws/lambda/${fn.name}:*`,
      },
      ...(fn.queue
        ? [
            {
              Effect: "Allow",
              Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
              Resource: queueArn(config, fn.queue),
            },
          ]
        : []),
      ...(fn.objects === "publication"
        ? [
            {
              Effect: "Allow",
              Action: ["s3:GetObject"],
              Resource: [`${bucketArn}/assets/*`, `${bucketArn}/publications/*`],
            },
            { Effect: "Allow", Action: ["s3:PutObject"], Resource: `${bucketArn}/publications/*` },
          ]
        : []),
      ...(fn.objects === "cleanup"
        ? [
            {
              Effect: "Allow",
              Action: ["s3:GetObject", "s3:DeleteObject"],
              Resource: `${bucketArn}/assets/*`,
            },
            { Effect: "Allow", Action: ["s3:GetBucketVersioning"], Resource: bucketArn },
            {
              Effect: "Allow",
              Action: ["sqs:SendMessage"],
              Resource: queueArn(config, profile.schedulerDlq),
            },
          ]
        : []),
    ];
    await c.iam.send(
      new iam.PutRolePolicyCommand({
        RoleName: fn.name,
        PolicyName: "application",
        PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: statements }),
      }),
    );
    await c.logs.send(
      new logs.CreateLogGroupCommand({ logGroupName: `/aws/lambda/${fn.name}`, tags }),
    );
    await c.logs.send(
      new logs.PutRetentionPolicyCommand({
        logGroupName: `/aws/lambda/${fn.name}`,
        retentionInDays: profile.bounds.logRetention,
      }),
    );
    await c.lambda.send(
      new lambda.CreateFunctionCommand({
        FunctionName: fn.name,
        Runtime: "nodejs22.x",
        Architectures: [manifest.architecture],
        Role: roleArn(fn.name),
        Handler: fn.handler,
        Code: { ZipFile: await readFile(new URL(`../../dist/${fn.bundle}.zip`, import.meta.url)) },
        Timeout: profile.bounds.timeout,
        MemorySize: profile.bounds.memory,
        Tags: tags,
        Environment: {
          Variables: {
            CONTENT_OPS_LAB_ID: config.instanceId,
            CONTENT_OPS_RUNTIME: "localstack",
            CONTENT_OPS_STAGE: "local",
            ...(fn.consumer ? { CONTENT_OPS_CONSUMER: fn.consumer } : {}),
          },
        },
      }),
    );
    await waitFor(`${fn.name} readiness`, async () => {
      const state = (await c.lambda.send(new lambda.GetFunctionCommand({ FunctionName: fn.name })))
        .Configuration?.State;
      if (state === "Failed")
        throw new LabError("Application Lambda failed to start; inspect owned logs.");
      return state === "Active" ? true : undefined;
    });
    await c.lambda.send(
      new lambda.PutFunctionConcurrencyCommand({
        FunctionName: fn.name,
        ReservedConcurrentExecutions: profile.bounds.concurrency,
      }),
    );
    if (fn.queue) {
      const mapping = await c.lambda.send(
        new lambda.CreateEventSourceMappingCommand({
          FunctionName: fn.name,
          EventSourceArn: queueArn(config, fn.queue),
          BatchSize: profile.bounds.batchSize,
          ScalingConfig: { MaximumConcurrency: profile.bounds.concurrency },
        }),
      );
      if (!mapping.UUID) throw new LabError("Missing application event mapping UUID.");
      manifest.mappings.push(mapping.UUID);
      await save();
      await waitFor("application mapping readiness", async () =>
        (await c.lambda.send(new lambda.GetEventSourceMappingCommand({ UUID: mapping.UUID! })))
          .State === "Enabled"
          ? true
          : undefined,
      );
    } else {
      await c.lambda.send(
        new lambda.PutFunctionEventInvokeConfigCommand({
          FunctionName: fn.name,
          MaximumRetryAttempts: 0,
          MaximumEventAgeInSeconds: 60,
          DestinationConfig: { OnFailure: { Destination: queueArn(config, profile.schedulerDlq) } },
        }),
      );
    }
  }
  await c.iam.send(
    new iam.CreateRoleCommand({
      RoleName: profile.schedulerRole,
      Tags: tagList,
      AssumeRolePolicyDocument: assumeRole("scheduler.amazonaws.com"),
    }),
  );
  await c.iam.send(
    new iam.PutRolePolicyCommand({
      RoleName: profile.schedulerRole,
      PolicyName: "application",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "lambda:InvokeFunction",
            Resource: functionArn(config, profile.jobs),
          },
          {
            Effect: "Allow",
            Action: "sqs:SendMessage",
            Resource: queueArn(config, profile.schedulerDlq),
          },
        ],
      }),
    }),
  );
  // Start schedules last, once every consumer/collector is ready.
  for (const item of profile.schedules)
    await c.scheduler.send(
      new scheduler.CreateScheduleCommand({
        Name: item.name,
        GroupName: config.scheduleGroup,
        ScheduleExpression: "rate(1 minute)",
        FlexibleTimeWindow: { Mode: "OFF" },
        State: "ENABLED",
        Target: {
          Arn: functionArn(config, profile.jobs),
          RoleArn: roleArn(profile.schedulerRole),
          Input: JSON.stringify({ targetHandler: item.targetHandler }),
          RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 },
          DeadLetterConfig: { Arn: queueArn(config, profile.schedulerDlq) },
        },
      }),
    );
  manifest.applicationVersion = profile.version;
  await save();
}

export async function cleanupApplication(
  c: LabClients,
  config: LabConfig,
  inventory: Awaited<ReturnType<typeof inspectApplication>>,
) {
  for (const name of inventory.schedules)
    await c.scheduler.send(
      new scheduler.DeleteScheduleCommand({ Name: name, GroupName: config.scheduleGroup }),
    );
  for (const id of inventory.mappings) {
    await missing(() => c.lambda.send(new lambda.DeleteEventSourceMappingCommand({ UUID: id })));
    await waitFor("application mapping deletion", async () =>
      (await missing(() =>
        c.lambda.send(new lambda.GetEventSourceMappingCommand({ UUID: id })),
      )) === undefined
        ? true
        : undefined,
    );
  }
  for (const name of inventory.rules) {
    const result = await c.events.send(
      new events.RemoveTargetsCommand({ Rule: name, EventBusName: config.bus, Ids: ["consumer"] }),
    );
    if (result.FailedEntryCount) throw new LabError("Application target removal failed.");
    await c.events.send(new events.DeleteRuleCommand({ Name: name, EventBusName: config.bus }));
  }
  for (const name of inventory.functions)
    await c.lambda.send(new lambda.DeleteFunctionCommand({ FunctionName: name }));
  for (const name of inventory.logGroups)
    await c.logs.send(new logs.DeleteLogGroupCommand({ logGroupName: name }));
  for (const url of inventory.queues)
    await c.sqs.send(new sqs.DeleteQueueCommand({ QueueUrl: url }));
  for (const name of inventory.roles) {
    await missing(() =>
      c.iam.send(new iam.DeleteRolePolicyCommand({ RoleName: name, PolicyName: "application" })),
    );
    await c.iam.send(new iam.DeleteRoleCommand({ RoleName: name }));
  }
}
