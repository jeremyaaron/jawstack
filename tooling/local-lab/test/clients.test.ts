import { expect, it } from "vitest";
import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import { createClients, destroyClients, requestFailure } from "../src/clients";
it("records only sanitized SDK operation identity without changing the rejected error", async () => {
  const clients = createClients(),
    error = new Error("sensitive test response must not be copied");
  clients.dynamo.middlewareStack.add(
    () => async () => {
      throw error;
    },
    { step: "finalizeRequest", name: "testBeforeNetwork" },
  );
  try {
    await expect(
      clients.dynamo.send(new GetItemCommand({ TableName: "unused", Key: { PK: { S: "x" } } })),
    ).rejects.toBe(error);
    expect(requestFailure(error)).toEqual({ client: "DynamoDBClient", command: "GetItemCommand" });
    expect(JSON.stringify(requestFailure(error))).not.toContain("sensitive");
  } finally {
    destroyClients(clients);
  }
});
