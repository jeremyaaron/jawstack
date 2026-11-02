import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  GetItemCommand,
  ListTagsOfResourceCommand,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import {
  GetBucketOwnershipControlsCommand,
  GetPublicAccessBlockCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { GetQueueAttributesCommand, GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { workerIdempotencyKey } from "@jawstack/aws-runtime";
import { assertOwned, LabError, localQueueUrl, type LabConfig, type LabManifest } from "./config";
import type { LabClients } from "./clients";
import { waitFor } from "./lifecycle";
import { setSchedule } from "./capabilities";
import { proofArtifact, putProofArtifact } from "./artifact";
import { executeProof } from "./resource";
import { inspectServices } from "@jawstack/local-lab";

async function getRecord(c: LabClients, config: LabConfig, PK: string, SK: string) {
  const result = await c.dynamo.send(
    new GetItemCommand({
      TableName: config.table,
      Key: marshall({ PK, SK }),
      ConsistentRead: true,
    }),
  );
  return result.Item ? unmarshall(result.Item) : undefined;
}

export async function verifyCapabilities(c: LabClients, config: LabConfig) {
  const id = randomUUID();
  const key = `proofs/duplicate_${id}.json`;
  const body = proofArtifact(id, id, "Conditional S3 proof");
  const stored = await Promise.all([
    putProofArtifact(c, config, key, body),
    putProofArtifact(c, config, key, body),
  ]);
  if (stored.filter((r) => r.created).length !== 1 || stored[0]?.digest !== stored[1]?.digest)
    throw new LabError("Concurrent conditional object creation did not converge.");
  let mismatchRejected = false;
  try {
    await putProofArtifact(c, config, key, `${body} `);
  } catch (error) {
    if (error instanceof LabError && error.message.includes("mismatch")) mismatchRejected = true;
    else throw error;
  }
  if (!mismatchRejected) throw new LabError("A different object body was not rejected.");
  const objects = await c.s3.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: key }));
  if (objects.Contents?.length !== 1) throw new LabError("Expected one conditional object.");
  const publicAccess = await c.s3.send(new GetPublicAccessBlockCommand({ Bucket: config.bucket }));
  const block = publicAccess.PublicAccessBlockConfiguration;
  if (
    !block?.BlockPublicAcls ||
    !block.IgnorePublicAcls ||
    !block.BlockPublicPolicy ||
    !block.RestrictPublicBuckets
  )
    throw new LabError("Bucket public access block is not configured.");
  const ownership = await c.s3.send(
    new GetBucketOwnershipControlsCommand({ Bucket: config.bucket }),
  );
  if (ownership.OwnershipControls?.Rules?.[0]?.ObjectOwnership !== "BucketOwnerEnforced")
    throw new LabError("Bucket ownership controls missing.");

  const deadline = Date.now() + 240_000;
  const remaining = () => Math.max(0, deadline - Date.now());
  const failedId = `failure_${randomUUID()}`;
  try {
    await setSchedule(c, config, id, true);
    const request = await executeProof(c, config, failedId, randomUUID(), id, {
      message: "Injected terminal failure",
      fail: true,
    });
    if (!request.ok) throw new LabError("Failure proof command was rejected.");
    const failure = await waitFor(
      "actual queue redrive and durable collector receipt",
      () => getRecord(c, config, `DLQ#${failedId}`, "FAILURE"),
      remaining(),
    );
    const attempts = await c.dynamo.send(
      new QueryCommand({
        TableName: config.table,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: marshall({ ":pk": `ATTEMPT#${failedId}` }),
        ConsistentRead: true,
      }),
    );
    const counts = (attempts.Items ?? []).map((item) => unmarshall(item).receiveCount);
    if (!isDeepStrictEqual(counts, [1, 2, 3]))
      throw new LabError("Failure did not observe exactly three worker receives before redrive.");
    if (await getRecord(c, config, `PROOF#${failedId}`, "RECEIPT"))
      throw new LabError("Failing work incorrectly produced a success receipt.");
    const eventId = String(failure.eventId);
    const workerMarker = workerIdempotencyKey("spineProof", eventId);
    if (await getRecord(c, config, workerMarker.PK, workerMarker.SK))
      throw new LabError("Failed work was incorrectly marked processed.");
    const marker = workerIdempotencyKey("spineFailureCollector", eventId);
    await waitFor(
      "collector completion marker",
      () => getRecord(c, config, marker.PK, marker.SK),
      remaining(),
    );
    const queue = await c.sqs.send(new GetQueueUrlCommand({ QueueName: config.dlq }));
    const url = localQueueUrl(queue.QueueUrl!, config, config.dlq);
    await waitFor(
      "DLQ acknowledgement after durable collection",
      async () => {
        const attributes = await c.sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: url,
            AttributeNames: [
              "ApproximateNumberOfMessages",
              "ApproximateNumberOfMessagesNotVisible",
            ],
          }),
        );
        return attributes.Attributes?.ApproximateNumberOfMessages === "0" &&
          attributes.Attributes.ApproximateNumberOfMessagesNotVisible === "0"
          ? true
          : undefined;
      },
      remaining(),
    );
    const tick = await waitFor(
      "automatic Scheduler invocation",
      () => getRecord(c, config, `SCHEDULE#${id}`, "FIRED"),
      remaining(),
    );
    const receipt = await waitFor(
      "scheduled command's actual worker/S3 outcome",
      () => getRecord(c, config, `PROOF#${tick.resourceId}`, "RECEIPT"),
      remaining(),
    );
    if (receipt.correlationId !== id || typeof receipt.artifactDigest !== "string")
      throw new LabError("Scheduled outcome mismatch.");
    return {
      storage: {
        conditionalCreators: 1,
        logicalObjects: 1,
        mismatchRejected,
        privateConfiguration: true,
      },
      scheduler: { trigger: "automatic rate(1 minute)", runId: id, resourceId: tick.resourceId },
      failure: {
        resourceId: failedId,
        eventId,
        workerReceiveCounts: counts,
        durablyCollected: true,
        acknowledged: true,
      },
    };
  } finally {
    await setSchedule(c, config, id, false);
  }
}

export async function assertResourcesAbsent(c: LabClients, manifest: LabManifest) {
  const { streams: _streams, ...inventory } = await inspectServices(c, manifest, "reset");
  void _streams;
  if (Object.values(inventory).some((items) => items.length))
    throw new LabError("Owned resources remain after cleanup.");
}

export async function verifySentinelReset(
  c: LabClients,
  config: LabConfig,
  ownerId: string,
  reset: () => Promise<void>,
  getManifest: () => LabManifest,
) {
  const token = randomUUID();
  const tableName = `${config.project}-sentinel-${token.slice(0, 8)}`;
  let created = false;
  const check = async () => {
    const table = await c.dynamo.send(new DescribeTableCommand({ TableName: tableName }));
    const tags = await c.dynamo.send(
      new ListTagsOfResourceCommand({ ResourceArn: table.Table!.TableArn! }),
    );
    assertOwned(Object.fromEntries((tags.Tags ?? []).map((t) => [t.Key!, t.Value!])), token);
    const record = await c.dynamo.send(
      new GetItemCommand({
        TableName: tableName,
        Key: marshall({ PK: "SENTINEL" }),
        ConsistentRead: true,
      }),
    );
    if (!record.Item || unmarshall(record.Item).nonce !== token)
      throw new LabError("Unrelated sentinel was altered.");
  };
  try {
    await c.dynamo.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "PK", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "PK", KeyType: "HASH" }],
        Tags: [{ Key: "jawstack:owner", Value: token }],
      }),
    );
    created = true;
    await waitFor("sentinel readiness", async () =>
      (await c.dynamo.send(new DescribeTableCommand({ TableName: tableName }))).Table
        ?.TableStatus === "ACTIVE"
        ? true
        : undefined,
    );
    await c.dynamo.send(
      new PutItemCommand({
        TableName: tableName,
        Item: marshall({ PK: "SENTINEL", nonce: token }),
      }),
    );
    await reset();
    await assertResourcesAbsent(c, getManifest());
    await check();
    return {
      table: tableName,
      foreignOwner: true,
      payloadUnchanged: true,
      ownedResourcesAbsent: true,
    };
  } finally {
    if (created) {
      await check();
      await c.dynamo.send(new DeleteTableCommand({ TableName: tableName }));
    }
  }
}
