import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { isDeepStrictEqual } from "node:util";
import type { JawStackEvent } from "@jawstack/core";
import type { LabClients } from "./clients";
import { LabError, type LabConfig } from "./config";
import { proofInput } from "./resource";
import { proofArtifact, putProofArtifact } from "./artifact";

export async function putRecordOnce(
  c: Pick<LabClients, "dynamo">,
  config: LabConfig,
  record: Record<string, unknown> & { PK: string; SK: string },
) {
  try {
    await c.dynamo.send(
      new PutItemCommand({
        TableName: config.table,
        Item: marshall(record),
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
    const existing = await c.dynamo.send(
      new GetItemCommand({
        TableName: config.table,
        Key: marshall({ PK: record.PK, SK: record.SK }),
        ConsistentRead: true,
      }),
    );
    if (!existing.Item || !isDeepStrictEqual(unmarshall(existing.Item), record))
      throw new LabError("Conflicting durable proof record.");
  }
}

function validateFact(fact: JawStackEvent, config: LabConfig) {
  if (
    fact.source !== config.source ||
    fact.eventType !== "spineProof.created" ||
    fact.resourceType !== "spineProof" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(fact.resourceId)
  )
    throw new LabError("Unexpected spine proof event.");
  return proofInput.parse(fact.payload);
}

export async function handleProofFact(
  c: Pick<LabClients, "dynamo" | "s3">,
  config: LabConfig,
  fact: JawStackEvent,
  receiveCount: number,
) {
  const payload = validateFact(fact, config);
  if (payload.fail) {
    await putRecordOnce(c, config, {
      PK: `ATTEMPT#${fact.resourceId}`,
      SK: `RECEIVE#${String(receiveCount).padStart(6, "0")}`,
      eventId: fact.eventId,
      receiveCount,
      correlationId: fact.correlationId,
    });
    throw new LabError("Injected proof failure.");
  }
  const artifact = await putProofArtifact(
    c,
    config,
    `proofs/${fact.resourceId}.json`,
    proofArtifact(fact.resourceId, fact.eventId, payload.message),
  );
  await putRecordOnce(c, config, {
    PK: `PROOF#${fact.resourceId}`,
    SK: "RECEIPT",
    eventId: fact.eventId,
    correlationId: fact.correlationId,
    message: payload.message,
    artifactKey: artifact.key,
    artifactDigest: artifact.digest,
  });
}

export async function collectFailure(
  c: Pick<LabClients, "dynamo">,
  config: LabConfig,
  fact: JawStackEvent,
) {
  if (!validateFact(fact, config).fail)
    throw new LabError("DLQ did not contain the injected failing fact.");
  // Returning is the acknowledgement boundary; a failed durable write must throw.
  await putRecordOnce(c, config, {
    PK: `DLQ#${fact.resourceId}`,
    SK: "FAILURE",
    eventId: fact.eventId,
    correlationId: fact.correlationId,
    originalEvent: fact,
  });
}
