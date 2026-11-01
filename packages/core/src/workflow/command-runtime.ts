import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  createResourceRegistry,
  executeCommand,
  JawStackDefinitionError,
  JawStackRuntimeError,
  type ApiError,
  type AuthContext,
  type CommandExecutionResult,
  type CommandExecutorOptions,
  type CommandRequest,
  type CommandUnitOfWork,
  type IdempotencyRecord,
  type ResourceRepository,
} from "../index";
import { assertWorkflowWritable, validateReadOnly } from "./command-context";
import { captureWorkflowIdentity } from "./identity";
import { coreIdempotency, storedResource } from "./stored";
import { component, freeze, instant, jsonCopy, type WorkflowReadonly } from "./validation";
import type { WorkflowCommandScope } from "./keys";

// Bind immutable scope/time per call; idempotency reads must be strong and expiry-filtered.
export type WorkflowPersistenceFactory = (
  scope: WorkflowCommandScope,
  now: Date,
) => Readonly<{
  repository: ResourceRepository & Required<Pick<ResourceRepository, "getIdempotency">>;
  unitOfWork: CommandUnitOfWork;
}>;
type CapturedRequest = Omit<CommandRequest, "requestContext">;
export type WorkflowResultValidator = (
  input: Readonly<{
    request: WorkflowReadonly<CapturedRequest>;
    result: WorkflowReadonly<CommandExecutionResult>;
    repository: Pick<ResourceRepository, "getState">;
    clock: () => Date;
  }>,
) => void | Promise<void>;

const retryable = new Set(["resource.conflict", "idempotency.conflict", "runtime.unavailable"]);

function failure(error: unknown, meta: CommandExecutionResult["meta"]): ApiError {
  return {
    ok: false,
    error:
      error instanceof JawStackRuntimeError
        ? { code: error.code, message: error.message }
        : { code: "runtime.internal", message: "An internal runtime error occurred." },
    meta,
  };
}

// Internal until the complete workflow surface is assembled in Phase 4.
export function createWorkflowCommandDispatch(options: {
  registry: CommandExecutorOptions["registry"];
  persistence: WorkflowPersistenceFactory;
  source: string;
  ids?: CommandExecutorOptions["ids"];
  clock?: () => Date;
  validateResult?: WorkflowResultValidator;
}) {
  const registry = createResourceRegistry(
    "getResource" in options.registry ? options.registry.resources : options.registry,
  );
  const persistence = options.persistence,
    source = options.source;
  const ids = { resourceId: () => randomUUID(), ...options.ids };
  const clock = options.clock ?? (() => new Date()),
    validator = options.validateResult;
  if (
    typeof persistence !== "function" ||
    typeof clock !== "function" ||
    typeof source !== "string" ||
    !source.trim() ||
    source.length > 200 ||
    (validator !== undefined && typeof validator !== "function")
  )
    throw new JawStackDefinitionError("workflow.command", "Invalid workflow command composition.");
  return async (
    request: CommandRequest,
    identity: AuthContext,
  ): Promise<CommandExecutionResult> => {
    let meta = { requestId: randomUUID() as string, correlationId: randomUUID() as string };
    try {
      assertWorkflowWritable();
      const captured: CapturedRequest = {
        resourceType: request.resourceType,
        commandName: request.commandName,
        input: request.input,
        ...(request.resourceId === undefined ? {} : { resourceId: request.resourceId }),
        ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
        requestId: request.requestId ?? ids.requestId?.() ?? meta.requestId,
        correlationId: request.correlationId ?? ids.correlationId?.() ?? meta.correlationId,
      };
      meta = {
        requestId: component(captured.requestId),
        correlationId: component(captured.correlationId),
      };
      component(captured.resourceType);
      component(captured.commandName);
      if (captured.resourceId !== undefined) component(captured.resourceId);
      const key = component(captured.idempotencyKey);
      const cleanRequest = freeze(jsonCopy(captured));
      const resolvedAuth = captureWorkflowIdentity(identity);
      const scope = freeze({
        resourceType: cleanRequest.resourceType,
        commandName: cleanRequest.commandName,
        subject: resolvedAuth.subject,
      });
      const capturedInstant = instant(new Date(clock().getTime()).toISOString());
      const scoped = persistence(scope, new Date(capturedInstant));
      const getState: ResourceRepository["getState"] = async (type, id) => {
        const value = await scoped.repository.getState(component(type), component(id));
        return value === undefined ? undefined : storedResource(value, type, id);
      };
      const getIdempotency = async (): Promise<IdempotencyRecord | undefined> => {
        const value = await scoped.repository.getIdempotency(key);
        return value === undefined ? undefined : coreIdempotency(value, key);
      };
      const coreRequest: CommandRequest = { ...cleanRequest, requestContext: undefined };
      const executor: CommandExecutorOptions = {
        registry,
        ids,
        source,
        clock: () => new Date(capturedInstant),
        authProvider: { resolve: () => resolvedAuth },
        repository: { getState, getIdempotency },
        unitOfWork: {
          commit: async (input) => {
            assertWorkflowWritable();
            await scoped.unitOfWork.commit(input);
          },
        },
      };
      let result = await executeCommand(coreRequest, executor);
      if (!result.ok && retryable.has(result.error.code)) {
        try {
          let winner: IdempotencyRecord | undefined;
          for (const pause of [0, 10, 25, 50]) {
            if (pause) await delay(pause);
            winner = await getIdempotency();
            if (winner) break;
          }
          if (winner) {
            const pinned = freeze(jsonCopy(winner));
            result = await executeCommand(coreRequest, {
              ...executor,
              repository: {
                getIdempotency: async () => pinned,
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
          }
        } catch (error) {
          if (error instanceof JawStackRuntimeError && error.code === "resource.invalid_state")
            result = failure(error, result.meta);
          // Lookup unavailability preserves the original result, never retries a mutation.
        }
      }
      const stable = freeze(jsonCopy(result));
      if (validator) {
        try {
          const returned = await validateReadOnly(() =>
            validator({
              request: cleanRequest,
              result: stable,
              repository: Object.freeze({
                getState: async (type, id) => {
                  const row = await getState(type, id);
                  return row === undefined ? undefined : freeze(row);
                },
              }),
              clock: () => new Date(clock().getTime()),
            }),
          );
          if (returned !== undefined)
            throw new JawStackRuntimeError(
              "runtime.internal",
              "Result validators cannot replace results.",
            );
        } catch (error) {
          if (stable.ok)
            return failure(
              error instanceof JawStackRuntimeError
                ? error
                : new JawStackRuntimeError(
                    "runtime.unavailable",
                    "Workflow result validation failed.",
                  ),
              stable.meta,
            );
        }
      }
      return stable;
    } catch (error) {
      return failure(error, meta);
    }
  };
}
