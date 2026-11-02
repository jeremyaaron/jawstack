import { compileWorkflowCommit } from "@jawstack/aws-runtime";
import type { CommandCommitInput, WorkflowCommitPlan } from "@jawstack/core";
import { createContentStorageSpec } from "../../src/application/workflow";
import type { CommandScope, OperationRecord } from "../../src/application/persistence";

// Assertion views of the actual shared planner/compiler, never an alternate write path.
export function prepareTransaction(
  input: CommandCommitInput,
  scope: CommandScope,
  now: Date,
  table: string,
) {
  const { planner } = createContentStorageSpec(input.outbox[0]?.source);
  const plan: WorkflowCommitPlan = planner.plan({ scope, now: now.toISOString() }, input);
  const compiled = compileWorkflowCommit(planner, plan, table);
  const operations = plan.actions
    .filter((a) => a.kind === "record")
    .map((a) => a.value as OperationRecord);
  const projections = plan.actions.flatMap((a) => (a.kind === "projection" ? [a.value] : []));
  const idempotency = plan.actions.find((a) => a.kind === "idempotency")!;
  if (idempotency.kind !== "idempotency") throw new Error("Missing scoped idempotency.");
  return {
    commit: { ...input, projections },
    operation: operations[0]!,
    operations,
    items: compiled.input.TransactItems!,
    idempotencyIndex: compiled.roles.indexOf("idempotency"),
    expiresAt: idempotency.value.expiresAt,
  };
}

export function legacyComparableItems(items: ReturnType<typeof prepareTransaction>["items"]) {
  return items.map((item) => {
    const result = structuredClone(item);
    const put = result.Put;
    if (!put) return result;
    const kind = put.Item?.itemKind?.S;
    if (kind === "ACTIVITY" || kind === "OUTBOX_EVENT") {
      if (put.ConditionExpression !== "attribute_not_exists(PK)")
        throw new Error("Immutable create condition missing.");
      delete put.ConditionExpression;
    }
    if (kind === "IDEMPOTENCY_RECORD") {
      if (
        put.ConditionExpression !== "attribute_not_exists(PK) OR #expires <= :now" ||
        put.ExpressionAttributeNames?.["#expires"] !== "expiresAt"
      )
        throw new Error("Expiry replacement condition changed.");
      put.ConditionExpression = "attribute_not_exists(PK) OR expiresAt <= :now";
      delete put.ExpressionAttributeNames;
    }
    return result;
  });
}
