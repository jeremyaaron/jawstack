import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { DescribeTableCommand, ListTagsOfResourceCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDbRepository } from "@jawstack/aws-runtime";
import { z } from "zod";
import { createContentDispatch } from "../src/application/dispatch";
import { createFailureService } from "../src/application/failures";
import { failureIdSchema } from "../src/application/failure-records";
import { createDynamoFailureStore } from "../src/aws/failures";
import { createDynamoPersistence } from "../src/aws/persistence";
import {
  assertCleanAwsEnvironment,
  assertOwned,
  createLabConfig,
  manifestSchema,
} from "../src/lab/config";
import { createClients, destroyClients } from "../src/lab/clients";
import { editorIds, fixtureAuth } from "../src/shared/identities";

export function parseJobsArgs(args: string[]) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      actor: { type: "string" },
      lab: { type: "string" },
      "request-id": { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
    },
  });
  const command = z.enum(["inspect", "replay"]).parse(positionals[0]);
  if (positionals.length > 2) throw new Error("Unexpected positional arguments.");
  const actor = z.enum(editorIds).parse(values.actor);
  const id = positionals[1] === undefined ? undefined : failureIdSchema.parse(positionals[1]);
  if (
    (command === "replay" && (!id || values.limit !== undefined || values.cursor !== undefined)) ||
    (command === "inspect" && values["request-id"] !== undefined) ||
    (id && command === "inspect" && (values.limit !== undefined || values.cursor !== undefined))
  )
    throw new Error("Invalid inspect/replay arguments.");
  const requestId =
    values["request-id"] === undefined ? randomUUID() : z.uuid().parse(values["request-id"]);
  const limit =
    values.limit === undefined ? 50 : z.coerce.number().int().min(1).max(100).parse(values.limit);
  const lab = values.lab ?? process.env.CONTENT_OPS_LAB_ID ?? "dev";
  createLabConfig(lab);
  const cursor =
    values.cursor === undefined ? undefined : z.string().min(1).max(8192).parse(values.cursor);
  return { command, actor, id, requestId, limit, lab, cursor };
}
async function main() {
  const args = parseJobsArgs(process.argv.slice(2));
  assertCleanAwsEnvironment(process.env);
  const config = createLabConfig(args.lab);
  const manifest = manifestSchema.parse(
    JSON.parse(
      await readFile(new URL(`../.localstack/${config.instanceId}.json`, import.meta.url), "utf8"),
    ),
  );
  if (manifest.instanceId !== config.instanceId || manifest.status !== "ready")
    throw new Error("A provisioned owned local lab is required.");
  const clients = createClients(config);
  try {
    const description = await clients.dynamo.send(
      new DescribeTableCommand({ TableName: config.table }),
    );
    if (!description.Table?.TableArn) throw new Error("Missing owned table.");
    const tags = await clients.dynamo.send(
      new ListTagsOfResourceCommand({ ResourceArn: description.Table.TableArn }),
    );
    if (tags.NextToken) throw new Error("Table ownership cannot be confirmed.");
    assertOwned(
      Object.fromEntries((tags.Tags ?? []).map((t) => [t.Key!, t.Value!])),
      manifest.ownerId,
    );
    const service = createFailureService({
      store: createDynamoFailureStore({
        client: clients.dynamo,
        tableName: config.table,
        source: config.source,
      }),
      repository: new DynamoDbRepository({ client: clients.dynamo, tableName: config.table }),
      dispatch: createContentDispatch({
        persistence: createDynamoPersistence({
          client: clients.dynamo,
          tableName: config.table,
          source: config.source,
        }),
        source: config.source,
      }),
      source: config.source,
    });
    const auth = fixtureAuth(args.actor);
    const result =
      args.command === "replay"
        ? await service.replay(args.id!, auth, args.requestId)
        : await service.inspect(
            auth,
            args.id
              ? { id: args.id }
              : { limit: args.limit, ...(args.cursor ? { cursor: args.cursor } : {}) },
          );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    destroyClients(clients);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(
      "Recovery command failed. Check arguments, editor identity, owned lab, and failure eligibility.",
    );
    process.exitCode = 1;
  });
