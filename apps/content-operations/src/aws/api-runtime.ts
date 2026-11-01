import { readFile } from "node:fs/promises";
import { DescribeTableCommand, ListTagsOfResourceCommand } from "@aws-sdk/client-dynamodb";
import {
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
} from "@aws-sdk/client-s3";
import { DynamoDbRepository } from "@jawstack/aws-runtime";
import {
  createLabConfig,
  assertCleanAwsEnvironment,
  assertOwned,
  manifestSchema,
} from "../lab/config";
import { createClients, destroyClients } from "../lab/clients";
import { createContentDispatch } from "../application/dispatch";
import { createUploadService } from "../application/uploads";
import type { ApiRuntime } from "../application/api-runtime";
import { createDynamoPersistence } from "./persistence";
import { createLocalS3ObjectStore } from "./object-store";
import { applicationTopologyVersion } from "./profile";

export async function createLocalstackApiRuntime(
  options: { labId?: string; clock?: () => Date } = {},
): Promise<ApiRuntime> {
  assertCleanAwsEnvironment(process.env);
  const config = createLabConfig(options.labId ?? "dev");
  const manifest = manifestSchema.parse(
    JSON.parse(
      await readFile(
        new URL(`../../.localstack/${config.instanceId}.json`, import.meta.url),
        "utf8",
      ),
    ),
  );
  if (
    manifest.instanceId !== config.instanceId ||
    manifest.status !== "ready" ||
    manifest.applicationVersion !== applicationTopologyVersion
  )
    throw new Error("A provisioned owned local lab is required.");
  const clients = createClients(config);
  let objects: ReturnType<typeof createLocalS3ObjectStore> | undefined;
  try {
    const description = await clients.dynamo.send(
      new DescribeTableCommand({ TableName: config.table }),
    );
    if (!description.Table?.TableArn) throw new Error("Missing owned table.");
    const tags = await clients.dynamo.send(
      new ListTagsOfResourceCommand({ ResourceArn: description.Table.TableArn }),
    );
    if (tags.NextToken) throw new Error("Cannot confirm table ownership.");
    assertOwned(
      Object.fromEntries((tags.Tags ?? []).map((tag) => [tag.Key!, tag.Value!])),
      manifest.ownerId,
    );
    const bucketTags = await clients.s3.send(
      new GetBucketTaggingCommand({ Bucket: config.bucket }),
    );
    assertOwned(
      Object.fromEntries((bucketTags.TagSet ?? []).map((tag) => [tag.Key!, tag.Value!])),
      manifest.ownerId,
    );
    const versioning = await clients.s3.send(
      new GetBucketVersioningCommand({ Bucket: config.bucket }),
    );
    const access = await clients.s3.send(
      new GetPublicAccessBlockCommand({ Bucket: config.bucket }),
    );
    if (
      versioning.Status ||
      !access.PublicAccessBlockConfiguration ||
      Object.values(access.PublicAccessBlockConfiguration).length !== 4 ||
      !Object.values(access.PublicAccessBlockConfiguration).every(Boolean)
    )
      throw new Error("The owned private unversioned bucket is required.");
    const clock = options.clock ?? (() => new Date());
    const repository = new DynamoDbRepository({ client: clients.dynamo, tableName: config.table });
    const dispatch = createContentDispatch({
      clock,
      source: config.source,
      persistence: createDynamoPersistence({ client: clients.dynamo, tableName: config.table }),
    });
    objects = createLocalS3ObjectStore(config);
    const store = objects;
    return {
      kind: "localstack",
      repository,
      dispatch,
      objects: store,
      clock,
      upload: createUploadService({ repository, dispatch, objects: store, clock }),
      close: () => {
        store.close();
        destroyClients(clients);
      },
    };
  } catch (error) {
    objects?.close();
    destroyClients(clients);
    throw error;
  }
}
