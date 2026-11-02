import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  GetItemCommand,
  ListTagsOfResourceCommand,
  QueryCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { z } from "zod";
import { createDynamoWorkflow, type DynamoDbClientLike } from "@jawstack/aws-runtime";
import {
  defineAtomicRecord,
  defineCommand,
  defineResource,
  defineState,
  defineWorker,
  defineWorkflow,
  field,
  type WorkflowRuntime,
} from "@jawstack/core";
import { LocalOnlyHttpHandler } from "../src/lab/clients";
import {
  assertCleanAwsEnvironment,
  assertOwned,
  createLabConfig,
  LabError,
  localstackImage,
  manifestSchema,
} from "../src/lab/config";
import { waitFor } from "../src/lab/provision";

// A table-only storage proof. No application provisioning, resets, streams or delivery drivers.
async function main() {
  assertCleanAwsEnvironment(process.env);
  const id = process.env.CONTENT_OPS_LAB_ID;
  if (!id?.startsWith("wf5-"))
    throw new LabError("Use a separate wf5-* lab, never the review lab.");
  const config = createLabConfig(id);
  const manifest = manifestSchema.parse(
    JSON.parse(
      await readFile(new URL(`../.localstack/${config.instanceId}.json`, import.meta.url), "utf8"),
    ),
  );
  if (manifest.instanceId !== id || manifest.image !== localstackImage)
    throw new LabError("Lab identity mismatch.");
  const docker = promisify(execFile);
  const containers = (
    await docker(
      "docker",
      ["ps", "-q", "--filter", `label=com.docker.compose.project=${config.project}`],
      { timeout: 10000 },
    )
  ).stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (containers.length !== 1) throw new LabError("Expected one owned running emulator.");
  const owner = (
    await docker(
      "docker",
      ["inspect", "--format", '{{index .Config.Labels "jawstack.owner"}}', containers[0]!],
      { timeout: 10000 },
    )
  ).stdout.trim();
  const image = (
    await docker("docker", ["inspect", "--format", "{{.Config.Image}}", containers[0]!], {
      timeout: 10000,
    })
  ).stdout.trim();
  if (owner !== manifest.ownerId || image !== localstackImage)
    throw new LabError("Emulator ownership/image mismatch.");
  const client = new DynamoDBClient({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 2,
    requestHandler: new LocalOnlyHttpHandler(config.endpoint),
  });
  const tableName = `${config.project}-wf5-${randomUUID().slice(0, 8)}`;
  let created = false,
    arn: string | undefined,
    workflow: WorkflowRuntime | undefined;
  const checkOwner = async () => {
    if (!arn) throw new LabError("Missing owned table ARN.");
    const tags = await client.send(new ListTagsOfResourceCommand({ ResourceArn: arn }));
    assertOwned(
      Object.fromEntries((tags.Tags ?? []).map((tag) => [tag.Key!, tag.Value!])),
      manifest.ownerId,
    );
    if (
      !tags.Tags?.some(
        (tag) => tag.Key === "jawstack:probe" && tag.Value === "workflow-storage-phase5",
      )
    )
      throw new LabError("Table probe tag mismatch.");
  };
  try {
    const table = await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        Tags: [
          { Key: "jawstack:owner", Value: manifest.ownerId },
          { Key: "jawstack:probe", Value: "workflow-storage-phase5" },
        ],
      }),
    );
    created = true;
    arn = table.TableDescription?.TableArn;
    await waitFor("workflow probe table", async () =>
      (await client.send(new DescribeTableCommand({ TableName: tableName }))).Table?.TableStatus ===
      "ACTIVE"
        ? true
        : undefined,
    );
    await checkOwner();
    const receipt = defineAtomicRecord({
      name: "receipt",
      schema: z.strictObject({ id: z.string(), version: z.number().int().positive() }),
      key: (value) => `${value.id}#${value.version}`,
      owner: (value) => ({ resourceType: "document", resourceId: value.id }),
    });
    let time = Date.parse("2026-11-01T12:00:00.000Z"),
      decisions = 0,
      transactions = 0,
      strongReads = 0,
      rollbackChecked = false;
    const definition = defineWorkflow({
      name: "storage-probe",
      source: "storage-probe",
      records: [receipt],
      commands: { idempotencyTtlSeconds: 604800 },
      contribute: ({ commit }) => ({
        records: [receipt.create({ id: commit.resource.resourceId, version: 1 })],
      }),
      resources: [
        defineResource({
          name: "document",
          title: "Document",
          state: defineState({ title: field.string() }),
          commands: Object.fromEntries(
            ["create", "edit"].map((command) => [
              command,
              defineCommand({
                title: command,
                create: command === "create",
                roles: ["operator"],
                input: z.strictObject({ title: z.string() }),
                emits: [{ eventType: "document.changed", schemaVersion: 1 }],
                decide: ({ input, resourceId }) => {
                  decisions++;
                  return {
                    nextState: input,
                    response: { id: resourceId },
                    activity: [{ activityType: "changed", title: "Changed" }],
                    events: [
                      {
                        eventType: "document.changed",
                        schemaVersion: 1,
                        payload: { id: resourceId },
                      },
                    ],
                    projections: [
                      {
                        projectionName: "document.list",
                        itemId: resourceId,
                        sort: "now",
                        data: input,
                      },
                    ],
                  };
                },
              }),
            ]),
          ),
          workers: [defineWorker({ name: "process", eventTypes: ["document.changed"] })],
        }),
      ],
      events: [
        {
          eventType: "document.changed",
          schemaVersion: 1,
          schema: z.strictObject({ id: z.string() }),
          validateIdentity: (event) =>
            event.resourceType === "document" && event.resourceId === event.payload.id,
        },
      ],
      consumers: { process: { recovery: "replay" } },
      operations: { resourceType: "document", projection: "document.failures" },
    });
    const guarded: DynamoDbClientLike = {
      send: async (command) => {
        if (
          !(
            command instanceof GetItemCommand ||
            command instanceof QueryCommand ||
            command instanceof TransactWriteItemsCommand
          )
        )
          throw new LabError("Unexpected probe SDK request.");
        if (command instanceof TransactWriteItemsCommand) {
          if (
            command.input.TransactItems?.some(
              (write) => (write.Put ?? write.Delete)?.TableName !== tableName,
            )
          )
            throw new LabError("Wrong probe transaction table.");
          transactions++;
          await checkOwner();
          const readTargets = () =>
            Promise.all(
              command.input.TransactItems!.map((write) => {
                const item = write.Put?.Item ?? write.Delete!.Key!;
                return client
                  .send(
                    new GetItemCommand({
                      TableName: tableName,
                      Key: { PK: item.PK!, SK: item.SK! },
                      ConsistentRead: true,
                    }),
                  )
                  .then((result) => result.Item);
              }),
            );
          if (transactions === 2) {
            const before = await readTargets();
            try {
              return await client.send(command);
            } finally {
              assert.deepEqual(await readTargets(), before);
              rollbackChecked = true;
            }
          }
          const result = await client.send(command);
          if (transactions === 3)
            throw new Error("Intentional lost successful transaction response.");
          return result;
        }
        if (command.input.TableName !== tableName) throw new LabError("Wrong probe table.");
        assert.equal(command.input.ConsistentRead, true);
        strongReads++;
        return command instanceof GetItemCommand ? client.send(command) : client.send(command);
      },
    };
    workflow = createDynamoWorkflow(definition, {
      client: guarded,
      tableName,
      clock: () => new Date(time),
      bind: () => ({ process: { handle: () => {} } }),
    });
    const identity = {
      subject: "operator",
      roles: ["operator"],
      mode: "test" as const,
      claims: {},
    };
    const run = (id: string, command = "create", key = "shared") =>
      workflow!.dispatch(
        {
          resourceType: "document",
          resourceId: id,
          commandName: command,
          input: { title: command },
          idempotencyKey: key,
          requestContext: {},
        },
        identity,
      );
    const first = await run("one");
    assert.equal(first.ok, true);
    assert.deepEqual(await run("one"), first);
    assert.equal(transactions, 1);
    const before = await workflow.queries.queryActivity({
      resourceType: "document",
      resourceId: "one",
    });
    const failed = await run("one", "edit", "edit");
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.error.code, "resource.conflict");
    assert.equal((await workflow.repository.getState("document", "one"))?.version, 1);
    assert.deepEqual(
      await workflow.queries.queryActivity({ resourceType: "document", resourceId: "one" }),
      before,
    );
    assert.equal(
      (await workflow.queries.queryProjection({ projectionName: "document.list" })).items[0]?.data
        .title,
      "create",
    );
    time += 604800000;
    // TTL is deliberately not enabled: replacement must be conditional, not deletion-driven.
    assert.equal(
      (
        await client.send(
          new GetItemCommand({
            TableName: tableName,
            Key: { PK: { S: "IDEMP#document#create#operator" }, SK: { S: "shared" } },
            ConsistentRead: true,
          }),
        )
      ).Item?.resourceId?.S,
      "one",
    );
    const replacement = await run("two");
    assert.equal(replacement.ok, true);
    assert.deepEqual(await run("two"), replacement);
    assert.equal(transactions, 3);
    assert.equal(decisions, 3);
    assert.equal(rollbackChecked, true);
    assert.deepEqual(await workflow.records.get(receipt, "two#1"), { id: "two", version: 1 });
    assert.equal(
      (
        await client.send(
          new GetItemCommand({
            TableName: tableName,
            Key: { PK: { S: "IDEMP#document#create#operator" }, SK: { S: "shared" } },
            ConsistentRead: true,
          }),
        )
      ).Item?.resourceId?.S,
      "two",
    );
    console.log(
      JSON.stringify({
        status: "passed",
        endpoint: config.endpoint,
        project: config.project,
        tableName,
        rollback: rollbackChecked,
        retainedTtlReplacement: true,
        uncertainCommitStrongReplay: true,
        transactions,
        strongReads,
        realAws: false,
      }),
    );
  } finally {
    try {
      await workflow?.close();
    } finally {
      try {
        if (created) {
          await checkOwner();
          await client.send(new DeleteTableCommand({ TableName: tableName }));
          await waitFor("workflow probe deletion", async () => {
            try {
              await client.send(new DescribeTableCommand({ TableName: tableName }));
              return undefined;
            } catch (error) {
              if (error instanceof Error && error.name === "ResourceNotFoundException") return true;
              throw error;
            }
          });
          console.log(JSON.stringify({ status: "cleaned", tableName, ownedTableDeleted: true }));
        }
      } finally {
        client.destroy();
      }
    }
  }
}
void main().catch(() => {
  console.error(
    "Owned workflow storage probe failed; diagnostics withheld. Inspect the isolated lab before retrying.",
  );
  process.exitCode = 1;
});
