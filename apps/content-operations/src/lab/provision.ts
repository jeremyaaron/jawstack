import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  ListTagsOfResourceCommand,
} from "@aws-sdk/client-dynamodb";
import {
  CreateEventBusCommand,
  DeleteEventBusCommand,
  DeleteRuleCommand,
  DescribeEventBusCommand,
  ListTagsForResourceCommand,
  PutRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand,
} from "@aws-sdk/client-eventbridge";
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  CreateEventSourceMappingCommand,
  CreateFunctionCommand,
  DeleteEventSourceMappingCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  GetEventSourceMappingCommand,
  ListEventSourceMappingsCommand,
  PutFunctionConcurrencyCommand,
} from "@aws-sdk/client-lambda";
import {
  CreateLogGroupCommand,
  DeleteLogGroupCommand,
  ListTagsLogGroupCommand,
  PutRetentionPolicyCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ListQueueTagsCommand,
  SetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  assertOwned,
  labFunctions,
  LabError,
  localQueueUrl,
  type LabConfig,
  type LabManifest,
} from "./config";
import type { LabClients } from "./clients";
import {
  assertCapabilitiesVacant,
  cleanupCapabilities,
  preflightCapabilities,
  provisionSchedule,
  provisionStorageAndDlq,
  queueArn as labQueueArn,
  stopCapabilitySchedule,
} from "./capabilities";

import { missing, waitFor } from "./lifecycle";
import {
  cleanupApplication,
  inspectApplication,
  provisionApplication,
} from "./application-topology";
export { missing, waitFor } from "./lifecycle";

const tags = (ownerId: string) => [{ Key: "jawstack:owner", Value: ownerId }];
const tagRecord = (
  values: { Key?: string | undefined; Value?: string | undefined }[] | undefined,
) => Object.fromEntries((values ?? []).map((t) => [t.Key ?? "", t.Value ?? ""]));

export async function provisionSpine(
  c: LabClients,
  config: LabConfig,
  manifest: LabManifest,
  save: () => Promise<void>,
): Promise<void> {
  if (manifest.status !== "starting")
    throw new LabError(
      "Lab already provisioned or partially provisioned; use local:reset before provisioning again.",
    );
  const collisions = [
    await missing(() => c.dynamo.send(new DescribeTableCommand({ TableName: config.table }))),
    await missing(() => c.events.send(new DescribeEventBusCommand({ Name: config.bus }))),
    await missing(() => c.iam.send(new GetRoleCommand({ RoleName: config.role }))),
    await missing(() => c.sqs.send(new GetQueueUrlCommand({ QueueName: config.queue }))),
  ];
  for (const { name } of labFunctions(config)) {
    collisions.push(
      await missing(() => c.lambda.send(new GetFunctionCommand({ FunctionName: name }))),
    );
    collisions.push(
      await missing(() =>
        c.logs.send(new ListTagsLogGroupCommand({ logGroupName: `/aws/lambda/${name}` })),
      ),
    );
  }
  if (collisions.some((resource) => resource !== undefined))
    throw new LabError(
      "A named resource already exists. Refusing to adopt or retag it; use ownership-checked reset.",
    );
  await assertCapabilitiesVacant(c, config);
  await inspectApplication(c, config);
  manifest.status = "provisioning";
  await save();
  await provisionStorageAndDlq(c, config, manifest.ownerId);
  const ownerTags = tags(manifest.ownerId);
  const arnBase = `arn:aws`;
  const tableArn = `${arnBase}:dynamodb:${config.region}:000000000000:table/${config.table}`;
  const busArn = `${arnBase}:events:${config.region}:000000000000:event-bus/${config.bus}`;
  const queueArn = `${arnBase}:sqs:${config.region}:000000000000:${config.queue}`;

  // Create the owned table first; all readiness waits have an explicit deadline.
  await c.dynamo.send(
    new CreateTableCommand({
      TableName: config.table,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: ["PK", "SK", "GSI1PK", "GSI1SK"].map((AttributeName) => ({
        AttributeName,
        AttributeType: "S",
      })),
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "GSI1",
          KeySchema: [
            { AttributeName: "GSI1PK", KeyType: "HASH" },
            { AttributeName: "GSI1SK", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
      StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" },
      Tags: ownerTags,
    }),
  );
  const table = await waitFor("table/stream readiness", async () => {
    const { Table } = await c.dynamo.send(new DescribeTableCommand({ TableName: config.table }));
    return Table?.TableStatus === "ACTIVE" && Table.LatestStreamArn ? Table : undefined;
  });
  manifest.streamArn = table.LatestStreamArn!;
  await save();
  await c.events.send(new CreateEventBusCommand({ Name: config.bus, Tags: ownerTags }));
  const queue = await c.sqs.send(
    new CreateQueueCommand({
      QueueName: config.queue,
      tags: { "jawstack:owner": manifest.ownerId },
      Attributes: {
        VisibilityTimeout: "30",
        MessageRetentionPeriod: "345600",
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: labQueueArn(config, config.dlq),
          maxReceiveCount: "3",
        }),
      },
    }),
  );
  manifest.queueUrl = localQueueUrl(queue.QueueUrl!, config);
  await save();
  const role = await c.iam.send(
    new CreateRoleCommand({
      RoleName: config.role,
      Tags: ownerTags,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    }),
  );
  await c.iam.send(
    new PutRolePolicyCommand({
      RoleName: config.role,
      PolicyName: "spine",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
              "dynamodb:TransactWriteItems",
            ],
            Resource: tableArn,
          },
          {
            Effect: "Allow",
            Action: [
              "dynamodb:DescribeStream",
              "dynamodb:GetRecords",
              "dynamodb:GetShardIterator",
              "dynamodb:ListStreams",
            ],
            Resource: `${tableArn}/stream/*`,
          },
          { Effect: "Allow", Action: ["events:PutEvents"], Resource: busArn },
          {
            Effect: "Allow",
            Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
            Resource: [queueArn, labQueueArn(config, config.dlq)],
          },
          {
            Effect: "Allow",
            Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: labFunctions(config)
              .map(({ name }) => name)
              .map(
                (name) =>
                  `${arnBase}:logs:${config.region}:000000000000:log-group:/aws/lambda/${name}:*`,
              ),
          },
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject"],
            Resource: `arn:aws:s3:::${config.bucket}/proofs/*`,
          },
        ],
      }),
    }),
  );
  const zip = await readFile(fileURLToPath(new URL("../../dist/spine.zip", import.meta.url)));
  for (const { name, handler, timeout } of labFunctions(config)) {
    await c.logs.send(
      new CreateLogGroupCommand({
        logGroupName: `/aws/lambda/${name}`,
        tags: { "jawstack:owner": manifest.ownerId },
      }),
    );
    await c.logs.send(
      new PutRetentionPolicyCommand({ logGroupName: `/aws/lambda/${name}`, retentionInDays: 7 }),
    );
    await c.lambda.send(
      new CreateFunctionCommand({
        FunctionName: name,
        Runtime: "nodejs22.x",
        Architectures: [manifest.architecture],
        Role: role.Role!.Arn!,
        Handler: handler,
        Code: { ZipFile: zip },
        Timeout: timeout,
        MemorySize: 256,
        Tags: { "jawstack:owner": manifest.ownerId },
        Environment: {
          Variables: {
            CONTENT_OPS_LAB_ID: config.instanceId,
            CONTENT_OPS_OWNER_ID: manifest.ownerId,
          },
        },
      }),
    );
    await waitFor(`${name} readiness`, async () => {
      const fn = await c.lambda.send(new GetFunctionCommand({ FunctionName: name }));
      if (fn.Configuration?.State === "Failed")
        throw new LabError(`Lambda ${name} failed to start; inspect its local logs.`);
      return fn.Configuration?.State === "Active" ? true : undefined;
    });
    await c.lambda.send(
      new PutFunctionConcurrencyCommand({ FunctionName: name, ReservedConcurrentExecutions: 2 }),
    );
  }
  await provisionSchedule(c, config, manifest.ownerId);
  await c.sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: manifest.queueUrl,
      Attributes: {
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "events.amazonaws.com" },
              Action: "sqs:SendMessage",
              Resource: queueArn,
              Condition: {
                ArnEquals: {
                  "aws:SourceArn": `${arnBase}:events:${config.region}:000000000000:rule/${config.bus}/${config.rule}`,
                },
              },
            },
          ],
        }),
      },
    }),
  );
  await c.events.send(
    new PutRuleCommand({
      Name: config.rule,
      EventBusName: config.bus,
      EventPattern: JSON.stringify({
        source: [config.source],
        "detail-type": ["spineProof.created"],
      }),
      Tags: ownerTags,
    }),
  );
  const targets = await c.events.send(
    new PutTargetsCommand({
      Rule: config.rule,
      EventBusName: config.bus,
      Targets: [{ Id: "proof-queue", Arn: queueArn }],
    }),
  );
  if (targets.FailedEntryCount) throw new LabError("Failed to attach the proof queue target.");
  for (const input of [
    {
      FunctionName: config.dispatcher,
      EventSourceArn: manifest.streamArn,
      StartingPosition: "TRIM_HORIZON" as const,
      BatchSize: 10,
    },
    {
      FunctionName: config.worker,
      EventSourceArn: queueArn,
      BatchSize: 1,
      ScalingConfig: { MaximumConcurrency: 2 },
    },
    {
      FunctionName: config.collector,
      EventSourceArn: labQueueArn(config, config.dlq),
      BatchSize: 1,
      ScalingConfig: { MaximumConcurrency: 2 },
    },
  ]) {
    const mapping = await c.lambda.send(new CreateEventSourceMappingCommand(input));
    if (!mapping.UUID) throw new LabError("Missing event mapping UUID.");
    manifest.mappings.push(mapping.UUID);
    await save();
    await waitFor("event source mapping readiness", async () => {
      const state = await c.lambda.send(new GetEventSourceMappingCommand({ UUID: mapping.UUID! }));
      return state.State === "Enabled" ? true : undefined;
    });
  }
  await provisionApplication(c, config, manifest, save);
  manifest.status = "ready";
  manifest.capabilitiesVersion = 1;
  manifest.runtimeOwnershipVersion = 1;
  await save();
}

export async function cleanupSpine(
  c: LabClients,
  config: LabConfig,
  manifest: LabManifest,
): Promise<void> {
  // Preflight every resource before deleting anything, including after a partial provision.
  const functions = [];
  for (const { name } of labFunctions(config)) {
    const fn = await missing(() => c.lambda.send(new GetFunctionCommand({ FunctionName: name })));
    if (fn) {
      assertOwned(fn.Tags, manifest.ownerId);
      functions.push(name);
    }
    const logTags = await missing(() =>
      c.logs.send(new ListTagsLogGroupCommand({ logGroupName: `/aws/lambda/${name}` })),
    );
    if (logTags) assertOwned(logTags.tags, manifest.ownerId);
  }
  const table = await missing(() =>
    c.dynamo.send(new DescribeTableCommand({ TableName: config.table })),
  );
  if (table?.Table?.TableArn)
    assertOwned(
      tagRecord(
        (await c.dynamo.send(new ListTagsOfResourceCommand({ ResourceArn: table.Table.TableArn })))
          .Tags,
      ),
      manifest.ownerId,
    );
  const bus = await missing(() => c.events.send(new DescribeEventBusCommand({ Name: config.bus })));
  if (bus?.Arn)
    assertOwned(
      tagRecord(
        (await c.events.send(new ListTagsForResourceCommand({ ResourceARN: bus.Arn }))).Tags,
      ),
      manifest.ownerId,
    );
  const role = await missing(() => c.iam.send(new GetRoleCommand({ RoleName: config.role })));
  if (role) assertOwned(tagRecord(role.Role?.Tags), manifest.ownerId);
  const queue = await missing(() =>
    c.sqs.send(new GetQueueUrlCommand({ QueueName: config.queue })),
  );
  const queueUrl = queue?.QueueUrl ? localQueueUrl(queue.QueueUrl, config) : undefined;
  if (queueUrl)
    assertOwned(
      (await c.sqs.send(new ListQueueTagsCommand({ QueueUrl: queueUrl }))).Tags,
      manifest.ownerId,
    );

  const mappingIds: string[] = [];
  for (const name of functions) {
    // Discover mappings as well as saved UUIDs so a crash between create and save is recoverable.
    const output = await c.lambda.send(new ListEventSourceMappingsCommand({ FunctionName: name }));
    if (output.NextMarker)
      throw new LabError("Unexpected mapping pagination; refusing partial cleanup.");
    for (const mapping of output.EventSourceMappings ?? []) {
      const expectedSource =
        name === config.dispatcher
          ? table?.Table?.LatestStreamArn
          : name === config.worker
            ? labQueueArn(config, config.queue)
            : name === config.collector
              ? labQueueArn(config, config.dlq)
              : undefined;
      if (!mapping.UUID || !expectedSource || mapping.EventSourceArn !== expectedSource) {
        throw new LabError("Unexpected event source mapping; refusing cleanup.");
      }
      mappingIds.push(mapping.UUID);
    }
  }
  const capabilities = await preflightCapabilities(c, config, manifest.ownerId);
  const application = await inspectApplication(c, config, manifest.ownerId);
  await stopCapabilitySchedule(c, config, capabilities.schedule);
  await cleanupApplication(c, config, application);
  for (const id of mappingIds) {
    await missing(() => c.lambda.send(new DeleteEventSourceMappingCommand({ UUID: id })));
    await waitFor("event mapping deletion", async () =>
      (await missing(() => c.lambda.send(new GetEventSourceMappingCommand({ UUID: id })))) ===
      undefined
        ? true
        : undefined,
    );
  }
  if (bus) {
    const removed = await c.events
      .send(
        new RemoveTargetsCommand({
          Rule: config.rule,
          EventBusName: config.bus,
          Ids: ["proof-queue"],
        }),
      )
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "ResourceNotFoundException") return undefined;
        throw error;
      });
    if (removed?.FailedEntryCount) throw new LabError("Could not remove the event target.");
    await missing(() =>
      c.events.send(new DeleteRuleCommand({ Name: config.rule, EventBusName: config.bus })),
    );
    await c.events.send(new DeleteEventBusCommand({ Name: config.bus }));
  }
  for (const name of functions)
    await c.lambda.send(new DeleteFunctionCommand({ FunctionName: name }));
  for (const { name } of labFunctions(config))
    await missing(() =>
      c.logs.send(new DeleteLogGroupCommand({ logGroupName: `/aws/lambda/${name}` })),
    );
  if (queueUrl) await c.sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
  await cleanupCapabilities(c, config, capabilities);
  if (table) {
    await c.dynamo.send(new DeleteTableCommand({ TableName: config.table }));
    await waitFor("table deletion", async () =>
      (await missing(() =>
        c.dynamo.send(new DescribeTableCommand({ TableName: config.table })),
      )) === undefined
        ? true
        : undefined,
    );
  }
  if (role) {
    await missing(() =>
      c.iam.send(new DeleteRolePolicyCommand({ RoleName: config.role, PolicyName: "spine" })),
    );
    await c.iam.send(new DeleteRoleCommand({ RoleName: config.role }));
  }
}
