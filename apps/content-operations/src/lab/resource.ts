import {
  defineCommand,
  defineResource,
  defineState,
  field,
  executeCommand,
  TestAuthProvider,
} from "@jawstack/core";
import { DynamoDbCommandUnitOfWork, DynamoDbRepository } from "@jawstack/aws-runtime";
import type { LabConfig } from "./config";
import type { LabClients } from "./clients";
import { z } from "zod";

export const proofInput = z
  .object({ message: z.string().min(1).max(100), fail: z.literal(true).optional() })
  .strict();

export const proofResource = defineResource({
  name: "spineProof",
  title: "Transactional Spine Proof",
  state: defineState({ message: field.string({ required: true }) }),
  commands: {
    create: defineCommand({
      title: "Create proof",
      create: true,
      roles: ["lab"],
      input: proofInput,
      emits: [{ eventType: "spineProof.created", schemaVersion: 1 }],
      decide: ({ input, resourceId, now }) => ({
        nextState: input,
        activity: [{ activityType: "created", title: "Spine proof committed" }],
        events: [{ eventType: "spineProof.created", schemaVersion: 1, payload: input }],
        projections: [
          {
            projectionName: "spineProof.list",
            itemId: resourceId,
            sort: now.toISOString(),
            data: input,
          },
        ],
        response: { resourceId },
      }),
    }),
  },
});

export function executeProof(
  c: Pick<LabClients, "dynamo">,
  config: LabConfig,
  resourceId: string,
  key: string,
  correlationId: string,
  input: z.infer<typeof proofInput>,
) {
  const scope = { resourceType: "spineProof", commandName: "create", subject: "lab_user" };
  return executeCommand(
    {
      resourceType: "spineProof",
      resourceId,
      commandName: "create",
      input,
      idempotencyKey: key,
      correlationId,
      requestContext: {},
    },
    {
      registry: [proofResource],
      repository: new DynamoDbRepository({
        client: c.dynamo,
        tableName: config.table,
        idempotencyScope: scope,
      }),
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
    },
  );
}
