import { AsyncLocalStorage } from "node:async_hooks";
import { JawStackRuntimeError } from "../index";
import { assertWorkflowWritable } from "./command-context";

const reconciling = /* @__PURE__ */ new AsyncLocalStorage<boolean>();
export function assertFailureWritable() {
  assertWorkflowWritable();
  if (reconciling.getStore())
    throw new JawStackRuntimeError(
      "command.rejected",
      "Reconciliation cannot mutate the failure ledger directly.",
    );
}
export function reconcileApplication<T>(callback: () => T): T {
  return reconciling.run(true, callback);
}
