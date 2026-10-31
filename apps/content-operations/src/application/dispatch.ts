import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  executeCommand,
  JawStackRuntimeError,
  type AuthContext,
  type CommandExecutorOptions,
  type CommandRequest,
} from "@jawstack/core";
import { createContentOperationsResources } from "../domain/resources";
import { captureScope, keyComponentSchema, type PersistenceFactory } from "./persistence";

export function createContentDispatch(options: {
  persistence: PersistenceFactory;
  clock?: () => Date;
  registry?: CommandExecutorOptions["registry"];
  ids?: CommandExecutorOptions["ids"];
}) {
  const registry = options.registry ?? createContentOperationsResources();
  // Authentication belongs to the ingress; only its resolved identity enters dispatch.
  return async (request: CommandRequest, identity: AuthContext) => {
    const auth = structuredClone(identity);
    const captured = structuredClone({ ...request, requestContext: undefined });
    const now = new Date((options.clock?.() ?? new Date()).getTime());
    let scoped: ReturnType<PersistenceFactory> | undefined;
    const executor: CommandExecutorOptions = {
      registry,
      clock: () => new Date(now),
      source: "content-operations",
      ids: { resourceId: () => randomUUID(), ...options.ids },
      authProvider: {
        resolve: () => {
          if (!keyComponentSchema.safeParse(captured.idempotencyKey).success)
            throw new JawStackRuntimeError(
              "command.rejected",
              "A bounded idempotency key is required.",
            );
          scoped ??= options.persistence(
            captureScope({
              resourceType: captured.resourceType,
              commandName: captured.commandName,
              subject: auth.subject,
            }),
            now,
          );
          return auth;
        },
      },
      repository: {
        getState: (type, id) => scoped!.repository.getState(type, id),
        getIdempotency: (key) => scoped!.repository.getIdempotency!(key),
      },
      unitOfWork: { commit: (input) => scoped!.unitOfWork.commit(input) },
    };
    const result = await executeCommand(captured, executor);
    if (
      result.ok ||
      !scoped ||
      !["resource.conflict", "idempotency.conflict", "runtime.unavailable"].includes(
        result.error.code,
      )
    )
      return result;

    // A winner may commit after our first lookup, even before our decision. Re-enter only
    // the core's fingerprint check with a pinned record: never retry a stale user mutation.
    try {
      let winner;
      for (const pause of [0, 10, 25, 50]) {
        if (pause) await delay(pause);
        winner = await scoped.repository.getIdempotency!(captured.idempotencyKey!);
        if (winner) break;
      }
      if (!winner) return result;
      return executeCommand(captured, {
        ...executor,
        repository: {
          getIdempotency: async () => winner,
          getState: async () => {
            throw new Error("Replay cannot load state.");
          },
        },
        unitOfWork: {
          commit: async () => {
            throw new Error("Replay cannot commit.");
          },
        },
      });
    } catch {
      return result;
    }
  };
}
