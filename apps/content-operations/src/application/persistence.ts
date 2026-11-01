import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  JawStackRuntimeError,
  type CommandCommitInput,
  type CommandUnitOfWork,
  type ResourceRepository,
} from "@jawstack/core";
import { buildCommandTransactWriteItems, projectionKey } from "@jawstack/aws-runtime";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  publicationOperationKey,
  publicationOperationProjections,
  publicationOperations,
  type PublicationOperation,
} from "./publication-operations";

export const idempotencyTtlSeconds = 7 * 24 * 60 * 60;
export const transactionActionLimit = 60;
export type CommandScope = Readonly<{
  resourceType: string;
  commandName: string;
  subject: string;
}>;
export type ScopedPersistence = Readonly<{
  repository: ResourceRepository;
  unitOfWork: CommandUnitOfWork;
}>;
export type PersistenceFactory = (scope: CommandScope, now: Date) => ScopedPersistence;

export const keyComponentSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[^A-Za-z0-9_.:-]/.test(value));
const component = keyComponentSchema;
const scopeSchema = z.strictObject({
  resourceType: component,
  commandName: component,
  subject: component,
});
const receiptSchema = z.strictObject({
  kind: z.literal("commandReceipt"),
  resourceType: component,
  resourceId: component,
  commandName: component,
  subject: component,
  version: z.number().int().positive().safe(),
  committedAt: z.iso.datetime({ precision: 3 }),
});
export type OperationRecord = z.infer<typeof receiptSchema> | PublicationOperation;

export function captureScope(scope: CommandScope): CommandScope {
  const parsed = scopeSchema.safeParse(scope);
  if (!parsed.success) throw new JawStackRuntimeError("command.rejected", "Invalid command scope.");
  return Object.freeze(parsed.data);
}

export function operationKey(record: OperationRecord) {
  if (record.kind === "publicationAttempt") return publicationOperationKey(record);
  return {
    PK: `OPS#${record.kind}`,
    SK: `${record.resourceType}#${record.resourceId}#${record.version}`,
  };
}

export function prepareTransaction(
  input: CommandCommitInput,
  scope: CommandScope,
  now: Date,
  tableName: string,
) {
  if (
    input.resource.resourceType !== scope.resourceType ||
    input.resource.next.updatedBy !== scope.subject ||
    !input.idempotency
  )
    throw new JawStackRuntimeError(
      "runtime.internal",
      "Commit does not match its invocation scope.",
    );
  const attempts = publicationOperations(input, scope.commandName);
  const projections = new Map<string, (typeof input.projections)[number]>();
  for (const row of [...input.projections, ...publicationOperationProjections(attempts)]) {
    const physical = projectionKey({ ...row, resourceType: scope.resourceType });
    const key = JSON.stringify(physical);
    const normalized = { ...row, sort: physical.SK };
    const previous = projections.get(key);
    if (previous && previous.delete !== true && row.delete !== true) {
      if (!isDeepStrictEqual(previous, normalized))
        throw new JawStackRuntimeError("runtime.internal", "Conflicting projection writes.");
    }
    if (!previous || previous.delete === true || row.delete !== true)
      projections.set(key, normalized);
  }
  const commit = structuredClone({ ...input, projections: [...projections.values()] });
  const parsed = receiptSchema.safeParse({
    kind: "commandReceipt",
    ...scope,
    resourceId: commit.resource.resourceId,
    version: commit.resource.next.version,
    committedAt: now.toISOString(),
  });
  if (!parsed.success)
    throw new JawStackRuntimeError("runtime.internal", "Invalid command receipt.");
  const operation = parsed.data;
  const expiresAt = Math.floor(now.getTime() / 1000) + idempotencyTtlSeconds;
  const items = buildCommandTransactWriteItems(commit, {
    tableName,
    idempotency: { ...scope, createdAt: now.toISOString(), expiresAt },
  });
  const idempotencyIndex = items.length - 1;
  const idempotencyPut = items[idempotencyIndex]!.Put!;
  idempotencyPut.ConditionExpression = "attribute_not_exists(PK) OR expiresAt <= :now";
  idempotencyPut.ExpressionAttributeValues = marshall({ ":now": Math.floor(now.getTime() / 1000) });
  const operations: OperationRecord[] = [operation, ...attempts];
  for (const record of operations)
    items.push({
      Put: {
        TableName: tableName,
        Item: marshall({ ...operationKey(record), itemKind: "APP_OPERATION", ...record }),
        ConditionExpression: "attribute_not_exists(PK)",
      },
    });
  const keys = new Set<string>();
  for (const item of items) {
    const write = item.Put ?? item.Delete;
    const key = item.Put?.Item ?? item.Delete?.Key;
    if (!write || !key)
      throw new JawStackRuntimeError("runtime.internal", "Invalid transaction action.");
    const identity = JSON.stringify([write.TableName, key.PK, key.SK]);
    if (keys.has(identity))
      throw new JawStackRuntimeError("runtime.internal", "Duplicate physical transaction key.");
    keys.add(identity);
  }
  if (items.length > transactionActionLimit)
    throw new JawStackRuntimeError(
      "command.rejected",
      "Application transaction exceeds 60 actions.",
    );
  return { commit, operation, operations, items, idempotencyIndex, expiresAt };
}
