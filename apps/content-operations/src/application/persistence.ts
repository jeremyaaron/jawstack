import { z } from "zod";
import {
  defineAtomicRecord,
  type WorkflowCommandScope,
  type WorkflowCommitContributor,
  type WorkflowPersistenceFactory,
} from "@jawstack/core";
import {
  publicationOperationKey,
  publicationOperationProjections,
  publicationOperations,
  publicationOperationSchema,
  type PublicationOperation,
} from "./publication-operations";

export const idempotencyTtlSeconds = 7 * 24 * 60 * 60;
export const transactionActionLimit = 60;
export type CommandScope = WorkflowCommandScope;
export type PersistenceFactory = WorkflowPersistenceFactory;
export const keyComponentSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
export const receiptSchema = z.strictObject({
  kind: z.literal("commandReceipt"),
  resourceType: keyComponentSchema,
  resourceId: keyComponentSchema,
  commandName: keyComponentSchema,
  subject: keyComponentSchema,
  version: z.number().int().positive().safe(),
  committedAt: z.iso.datetime({ precision: 3 }),
});
export type OperationRecord = z.infer<typeof receiptSchema> | PublicationOperation;
export function operationKey(record: OperationRecord) {
  if (record.kind === "publicationAttempt") return publicationOperationKey(record);
  return {
    PK: "OPS#commandReceipt",
    SK: `${record.resourceType}#${record.resourceId}#${record.version}`,
  };
}
export const commandReceiptRecord = defineAtomicRecord({
  name: "commandReceipt",
  schema: receiptSchema,
  key: (value) => operationKey(value).SK,
  owner: ({ resourceType, resourceId }) => ({ resourceType, resourceId }),
});
export const publicationAttemptRecord = defineAtomicRecord({
  name: "publicationAttempt",
  schema: publicationOperationSchema,
  key: (value) => publicationOperationKey(value).SK,
  owner: (value) => ({ resourceType: "contentItem", resourceId: value.contentId }),
});
export const contributeContentCommand: WorkflowCommitContributor = ({ invocation, commit }) => {
  const attempts = publicationOperations(commit, invocation.scope.commandName);
  const receiptValue = {
    kind: "commandReceipt" as const,
    ...invocation.scope,
    resourceId: commit.resource.resourceId,
    version: commit.resource.next.version,
    committedAt: invocation.now,
  };
  return {
    records: [
      commandReceiptRecord.create(receiptValue),
      ...attempts.map((record) => publicationAttemptRecord.create(record)),
    ],
    projections: publicationOperationProjections(attempts),
  };
};
