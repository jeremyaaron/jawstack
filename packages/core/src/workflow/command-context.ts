import { AsyncLocalStorage } from "node:async_hooks";
import { JawStackRuntimeError } from "../index";

const validationContext = new AsyncLocalStorage<boolean>();

export function assertWorkflowWritable(): void {
  if (validationContext.getStore())
    throw new JawStackRuntimeError(
      "command.rejected",
      "Result validation cannot dispatch or commit.",
    );
}

export function validateReadOnly<T>(callback: () => T): T {
  return validationContext.run(true, callback);
}
