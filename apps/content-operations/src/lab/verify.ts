import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { GetItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { executeCommand, TestAuthProvider } from "@jawstack/core";
import {
  DynamoDbCommandUnitOfWork,
  DynamoDbRepository,
  idempotencyKey,
  outboxEventKey,
  resourceStateKey,
} from "@jawstack/aws-runtime";
import { proofResource } from "./resource";
import { LabError, type LabConfig } from "./config";
import type { LabClients } from "./clients";
import { waitFor } from "./provision";

export async function verifySpine(c: LabClients, config: LabConfig) {
  const resourceId = `proof_${randomUUID()}`;
  const key = randomUUID();
  const correlationId = randomUUID();
  const scope = { resourceType: "spineProof", commandName: "create", subject: "lab_user" };
  const repository = new DynamoDbRepository({
    client: c.dynamo,
    tableName: config.table,
    idempotencyScope: scope,
  });
  const options = {
    registry: [proofResource],
    repository,
    unitOfWork: new DynamoDbCommandUnitOfWork({
      client: c.dynamo,
      tableName: config.table,
      idempotency: { commandName: scope.commandName, subject: scope.subject },
    }),
    authProvider: new TestAuthProvider({
      subject: scope.subject,
      roles: ["lab"],
      claims: {},
      mode: "test",
    }),
    source: config.source,
  };
  const request = {
    resourceType: "spineProof",
    resourceId,
    commandName: "create",
    input: { message: "Phase 0 transactional proof" },
    idempotencyKey: key,
    correlationId,
    requestContext: {},
  };
  const result = await executeCommand(request, options);
  if (!result.ok) throw new LabError(`Proof command failed: ${result.error.code}.`);
  const replay = await executeCommand(request, options);
  if (!isDeepStrictEqual(result, replay))
    throw new LabError("Idempotent command replay changed its stored response.");
  const get = async (key: Record<string, string>) => {
    const output = await c.dynamo.send(
      new GetItemCommand({ TableName: config.table, Key: marshall(key), ConsistentRead: true }),
    );
    return output.Item ? unmarshall(output.Item) : undefined;
  };
  const state = await get(resourceStateKey("spineProof", resourceId));
  const idempotency = await get(idempotencyKey({ ...scope, idempotencyKey: key }));
  const activity = await repository.getActivity("spineProof", resourceId);
  const projections = await repository.listProjection("spineProof.list");
  if (
    state?.version !== 1 ||
    !idempotency ||
    activity.length !== 1 ||
    !projections.some((p) => p.itemId === resourceId)
  )
    throw new LabError("Missing transactional proof records.");
  const receipt = await waitFor("real stream/EventBridge/SQS/Lambda receipt", async () =>
    get({ PK: `PROOF#${resourceId}`, SK: "RECEIPT" }),
  );
  if (
    receipt.correlationId !== correlationId ||
    receipt.message !== request.input.message ||
    typeof receipt.eventId !== "string"
  )
    throw new LabError("Worker receipt did not match the committed command.");
  await waitFor("outbox publication marker", async () => {
    const event = await get(outboxEventKey(receipt.eventId as string));
    return event?.status === "PUBLISHED" ? true : undefined;
  });
  const records = await c.dynamo.send(
    new QueryCommand({
      TableName: config.table,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: marshall({ ":pk": `PROOF#${resourceId}` }),
      ConsistentRead: true,
    }),
  );
  if (records.Count !== 1) throw new LabError("Expected exactly one logical worker receipt.");
  return {
    resourceId,
    correlationId,
    eventId: receipt.eventId,
    records: [
      "state",
      "activity",
      "projection",
      "idempotency",
      "published outbox",
      "worker receipt",
    ],
    commandReplay: "passed",
  };
}
