import { z } from "zod";
import { JawStackRuntimeError, type IdempotencyRecord, type ResourceState } from "../index";
import { stateSchema, successSchema } from "./commit-plan";
import { component, instant, jsonCopy, workflowCommitLimits } from "./validation";
import type { WorkflowCommandScope } from "./keys";

export type StoredWorkflowIdempotency = IdempotencyRecord &
  WorkflowCommandScope & {
    createdAt: string;
    expiresAt: number;
  };
const idempotencyFields = {
  key: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
  fingerprint: z.string().min(1),
  response: successSchema,
};
const coreIdempotencySchema = z.strictObject(idempotencyFields);
const storedIdempotencySchema = z.strictObject({
  ...idempotencyFields,
  resourceType: z.string(),
  commandName: z.string(),
  subject: z.string(),
  createdAt: z.string(),
  expiresAt: z.number().int().safe().positive(),
});

export function invalidStored(): never {
  throw new JawStackRuntimeError("resource.invalid_state", "Stored workflow record is invalid.");
}

export function storedResource(value: unknown, type: string, id: string): ResourceState {
  try {
    const copy = jsonCopy(value, workflowCommitLimits.recordBytes);
    const parsed = stateSchema.safeParse(copy);
    if (
      !parsed.success ||
      parsed.data.resourceType !== type ||
      parsed.data.resourceId !== id ||
      parsed.data.createdAt > parsed.data.updatedAt
    )
      invalidStored();
    return copy as ResourceState;
  } catch {
    return invalidStored();
  }
}

export function coreIdempotency(value: unknown, key: string): IdempotencyRecord {
  try {
    const copy = jsonCopy(value, workflowCommitLimits.recordBytes);
    const parsed = coreIdempotencySchema.safeParse(copy);
    if (!parsed.success || parsed.data.key !== key) invalidStored();
    return copy as IdempotencyRecord;
  } catch {
    return invalidStored();
  }
}

export function storedIdempotency(
  value: unknown,
  scope: WorkflowCommandScope,
  key: string,
): StoredWorkflowIdempotency {
  try {
    const copy = jsonCopy(value, workflowCommitLimits.recordBytes);
    const parsed = storedIdempotencySchema.safeParse(copy);
    if (!parsed.success) invalidStored();
    const row = parsed.data;
    if (
      component(row.resourceType) !== scope.resourceType ||
      component(row.commandName) !== scope.commandName ||
      component(row.subject) !== scope.subject ||
      row.key !== key ||
      row.expiresAt <= Math.floor(Date.parse(instant(row.createdAt)) / 1000) ||
      row.expiresAt >
        Math.floor(Date.parse(row.createdAt) / 1000) + workflowCommitLimits.idempotencyTtlSeconds
    )
      invalidStored();
    return copy as StoredWorkflowIdempotency;
  } catch {
    return invalidStored();
  }
}
