import {
  createWorkflowCommandDispatch,
  JawStackRuntimeError,
  type CommandExecutorOptions,
} from "@jawstack/core";
import { createContentOperationsResources } from "../domain/resources";
import type { PersistenceFactory } from "./persistence";
import { contentEventSource } from "../shared/events";
import { validateClaimResponse } from "./publication-claim";

export function createContentDispatch(options: {
  persistence: PersistenceFactory;
  clock?: () => Date;
  registry?: CommandExecutorOptions["registry"];
  ids?: CommandExecutorOptions["ids"];
  source?: string;
}) {
  return createWorkflowCommandDispatch({
    ...options,
    registry: options.registry ?? createContentOperationsResources(),
    source: options.source ?? contentEventSource,
    validateResult: async ({ request, result, repository, clock }) => {
      const checked = await validateClaimResponse(request, result, repository, clock);
      if (!checked.ok && result.ok)
        throw new JawStackRuntimeError(checked.error.code, checked.error.message);
    },
  });
}
