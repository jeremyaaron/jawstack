import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketOwnershipControlsCommand,
  PutBucketTaggingCommand,
  PutPublicAccessBlockCommand,
} from "@aws-sdk/client-s3";
import {
  CreateScheduleCommand,
  CreateScheduleGroupCommand,
  DeleteScheduleCommand,
  DeleteScheduleGroupCommand,
  GetScheduleCommand,
  GetScheduleGroupCommand,
  ListTagsForResourceCommand,
  UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler";
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ListQueueTagsCommand,
} from "@aws-sdk/client-sqs";
import { assertOwned, LabError, localQueueUrl, type LabConfig } from "./config";
import type { LabClients } from "./clients";
import { missing, waitFor } from "./lifecycle";

export const queueArn = (config: LabConfig, name: string) =>
  `arn:aws:sqs:${config.region}:000000000000:${name}`;
export const functionArn = (config: LabConfig, name: string) =>
  `arn:aws:lambda:${config.region}:000000000000:function:${name}`;
export const schedulerRoleArn = (config: LabConfig) =>
  `arn:aws:iam::000000000000:role/${config.schedulerRole}`;

export async function assertCapabilitiesVacant(c: LabClients, config: LabConfig) {
  const collisions = [
    await missing(() => c.s3.send(new HeadBucketCommand({ Bucket: config.bucket }))),
    await missing(() => c.sqs.send(new GetQueueUrlCommand({ QueueName: config.dlq }))),
    await missing(() =>
      c.scheduler.send(new GetScheduleGroupCommand({ Name: config.scheduleGroup })),
    ),
    await missing(() => c.iam.send(new GetRoleCommand({ RoleName: config.schedulerRole }))),
  ];
  if (collisions.some((x) => x !== undefined))
    throw new LabError("A capability resource already exists; refusing adoption or retagging.");
}

export async function provisionStorageAndDlq(c: LabClients, config: LabConfig, ownerId: string) {
  await c.s3.send(new CreateBucketCommand({ Bucket: config.bucket }));
  await c.s3.send(
    new PutBucketTaggingCommand({
      Bucket: config.bucket,
      Tagging: { TagSet: [{ Key: "jawstack:owner", Value: ownerId }] },
    }),
  );
  await c.s3.send(
    new PutBucketOwnershipControlsCommand({
      Bucket: config.bucket,
      OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
    }),
  );
  await c.s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: config.bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
  await c.sqs.send(
    new CreateQueueCommand({
      QueueName: config.dlq,
      tags: { "jawstack:owner": ownerId },
      Attributes: { VisibilityTimeout: "30", MessageRetentionPeriod: "1209600" },
    }),
  );
}

export async function provisionSchedule(c: LabClients, config: LabConfig, ownerId: string) {
  const tags = [{ Key: "jawstack:owner", Value: ownerId }];
  await c.scheduler.send(
    new CreateScheduleGroupCommand({ Name: config.scheduleGroup, Tags: tags }),
  );
  await c.iam.send(
    new CreateRoleCommand({
      RoleName: config.schedulerRole,
      Tags: tags,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "scheduler.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    }),
  );
  await c.iam.send(
    new PutRolePolicyCommand({
      RoleName: config.schedulerRole,
      PolicyName: "invoke-tick",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "lambda:InvokeFunction",
            Resource: functionArn(config, config.scheduled),
          },
        ],
      }),
    }),
  );
  await c.scheduler.send(
    new CreateScheduleCommand({
      Name: config.schedule,
      GroupName: config.scheduleGroup,
      ScheduleExpression: "rate(1 minute)",
      FlexibleTimeWindow: { Mode: "OFF" },
      State: "DISABLED",
      Target: {
        Arn: functionArn(config, config.scheduled),
        RoleArn: schedulerRoleArn(config),
        Input: JSON.stringify({ targetHandler: "spineTick", runId: "inactive" }),
        RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 },
      },
    }),
  );
}

export async function setSchedule(
  c: LabClients,
  config: LabConfig,
  runId: string,
  enabled: boolean,
) {
  const current = await c.scheduler.send(
    new GetScheduleCommand({ Name: config.schedule, GroupName: config.scheduleGroup }),
  );
  if (
    current.Target?.Arn !== functionArn(config, config.scheduled) ||
    current.Target.RoleArn !== schedulerRoleArn(config)
  )
    throw new LabError("Unexpected scheduler target; refusing update.");
  await c.scheduler.send(
    new UpdateScheduleCommand({
      Name: config.schedule,
      GroupName: config.scheduleGroup,
      ScheduleExpression: "rate(1 minute)",
      FlexibleTimeWindow: { Mode: "OFF" },
      State: enabled ? "ENABLED" : "DISABLED",
      Target: { ...current.Target, Input: JSON.stringify({ targetHandler: "spineTick", runId }) },
    }),
  );
}

export async function preflightCapabilities(c: LabClients, config: LabConfig, ownerId: string) {
  const bucket = await missing(() => c.s3.send(new HeadBucketCommand({ Bucket: config.bucket })));
  if (bucket) {
    const tags = await c.s3.send(new GetBucketTaggingCommand({ Bucket: config.bucket }));
    assertOwned(Object.fromEntries((tags.TagSet ?? []).map((t) => [t.Key!, t.Value!])), ownerId);
    const versioning = await c.s3.send(new GetBucketVersioningCommand({ Bucket: config.bucket }));
    if (versioning.Status)
      throw new LabError("Unexpected bucket versioning; refusing incomplete object cleanup.");
  }
  const queue = await missing(() => c.sqs.send(new GetQueueUrlCommand({ QueueName: config.dlq })));
  const dlqUrl = queue?.QueueUrl ? localQueueUrl(queue.QueueUrl, config, config.dlq) : undefined;
  if (dlqUrl)
    assertOwned((await c.sqs.send(new ListQueueTagsCommand({ QueueUrl: dlqUrl }))).Tags, ownerId);
  const group = await missing(() =>
    c.scheduler.send(new GetScheduleGroupCommand({ Name: config.scheduleGroup })),
  );
  if (group?.Arn) {
    const tags = await c.scheduler.send(new ListTagsForResourceCommand({ ResourceArn: group.Arn }));
    assertOwned(Object.fromEntries((tags.Tags ?? []).map((t) => [t.Key!, t.Value!])), ownerId);
  }
  const role = await missing(() =>
    c.iam.send(new GetRoleCommand({ RoleName: config.schedulerRole })),
  );
  if (role)
    assertOwned(
      Object.fromEntries((role.Role?.Tags ?? []).map((t) => [t.Key!, t.Value!])),
      ownerId,
    );
  const schedule = await missing(() =>
    c.scheduler.send(
      new GetScheduleCommand({ Name: config.schedule, GroupName: config.scheduleGroup }),
    ),
  );
  if (
    schedule &&
    (!group ||
      schedule.Target?.Arn !== functionArn(config, config.scheduled) ||
      schedule.Target.RoleArn !== schedulerRoleArn(config))
  )
    throw new LabError("Unexpected scheduler ownership/target; refusing cleanup.");
  return {
    bucket: bucket !== undefined,
    dlqUrl,
    group: group !== undefined,
    role: role !== undefined,
    schedule: schedule !== undefined,
  };
}

export async function cleanupCapabilities(
  c: LabClients,
  config: LabConfig,
  owned: Awaited<ReturnType<typeof preflightCapabilities>>,
) {
  if (owned.bucket) {
    const keys: string[] = [];
    const cursors = new Set<string>();
    let pages = 0;
    let cursor: string | undefined;
    do {
      if (++pages > 10 || (cursor && cursors.has(cursor)))
        throw new LabError("Object listing exceeds the cleanup page budget or repeats a cursor.");
      if (cursor) cursors.add(cursor);
      const page = await c.s3.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          MaxKeys: 1000,
          ...(cursor ? { ContinuationToken: cursor } : {}),
        }),
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key) throw new LabError("Invalid object listing.");
        keys.push(object.Key);
      }
      if (keys.length > 10_000)
        throw new LabError("Bucket exceeds the bounded lab cleanup budget.");
      if (page.IsTruncated && !page.NextContinuationToken)
        throw new LabError("Missing object continuation token.");
      cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (cursor);
    for (let index = 0; index < keys.length; index += 1000) {
      const result = await c.s3.send(
        new DeleteObjectsCommand({
          Bucket: config.bucket,
          Delete: { Objects: keys.slice(index, index + 1000).map((Key) => ({ Key })) },
        }),
      );
      if (result.Errors?.length)
        throw new LabError("Object cleanup failed; bucket and manifest retained.");
    }
    await c.s3.send(new DeleteBucketCommand({ Bucket: config.bucket }));
  }
  if (owned.dlqUrl) await c.sqs.send(new DeleteQueueCommand({ QueueUrl: owned.dlqUrl }));
  if (owned.group) {
    await c.scheduler.send(new DeleteScheduleGroupCommand({ Name: config.scheduleGroup }));
    await waitFor("schedule group deletion", async () =>
      (await missing(() =>
        c.scheduler.send(new GetScheduleGroupCommand({ Name: config.scheduleGroup })),
      )) === undefined
        ? true
        : undefined,
    );
  }
  if (owned.role) {
    await missing(() =>
      c.iam.send(
        new DeleteRolePolicyCommand({ RoleName: config.schedulerRole, PolicyName: "invoke-tick" }),
      ),
    );
    await c.iam.send(new DeleteRoleCommand({ RoleName: config.schedulerRole }));
  }
}

export async function stopCapabilitySchedule(c: LabClients, config: LabConfig, exists: boolean) {
  if (exists)
    await c.scheduler.send(
      new DeleteScheduleCommand({ Name: config.schedule, GroupName: config.scheduleGroup }),
    );
}
