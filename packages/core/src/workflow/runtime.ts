import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  JawStackRuntimeError,
  JawStackDefinitionError,
  type AuthContext,
  type CommandRequest,
  type CommandExecutionResult,
  type ResourceRepository,
  type QueryRepository,
  type JawStackEvent,
} from "../index";
import {
  workflowDefinition,
  ownEntries,
  workflowDefinitionError,
  type WorkflowDefinition,
} from "./definition";
import {
  createWorkflowCommandDispatch,
  type WorkflowPersistenceFactory,
  type WorkflowResultValidator,
} from "./command-runtime";
import {
  createWorkflowFailureService,
  type WorkflowOperationsAuthorizer,
  type FailureHooks,
} from "./failures";
import type { WorkflowFailureStore } from "./failure-records";
import { createWorkflowDelivery, type WorkflowMarkerStore } from "./delivery";
import {
  readRecord,
  resolveRecord,
  type AtomicRecordDefinition,
  type AtomicRecordOwner,
} from "./records";
import { component, jsonCopy, utf8 } from "./validation";
import { invalidStored, storedIdempotency, storedResource } from "./stored";
import { activitySchema, projectionSchema } from "./commit-plan";
import { assertWorkflowWritable } from "./command-context";

export type WorkflowRecordRow = Readonly<{
  collection: string;
  owner: AtomicRecordOwner;
  value: unknown;
}>;
export type WorkflowStorage = Readonly<{
  command: WorkflowPersistenceFactory;
  repository: Pick<ResourceRepository, "getState">;
  queries: QueryRepository;
  records: { get(collection: string, logicalKey: string): Promise<WorkflowRecordRow | undefined> };
  failures: WorkflowFailureStore;
  markers: WorkflowMarkerStore;
  close?(): void | Promise<void>;
}>;
export type WorkflowStorageSpec = Readonly<
  Pick<ReturnType<typeof workflowDefinition>, "planner" | "protocol" | "manifest">
> &
  Readonly<{
    validation: Readonly<{
      json: typeof jsonCopy;
      resource: typeof storedResource;
      idempotency: typeof storedIdempotency;
      record(collection: string, logicalKey: string, value: unknown): WorkflowRecordRow;
      activity(value: unknown): import("../index").ActivityRecord;
      projection(value: unknown): import("../index").ProjectionWrite;
    }>;
  }>;
export type WorkflowStorageFactory = (spec: WorkflowStorageSpec) => WorkflowStorage;
export type WorkflowDeliveryEvent = JawStackEvent<Record<string, unknown>> &
  Readonly<{
    originalEventId: string;
    recovery?: Readonly<{
      originalEventId: string;
      generation: number;
      consumer: string;
      failureId: string;
    }>;
  }>;
export type WorkflowConsumerBinding = FailureHooks &
  Readonly<{
    handle(
      event: WorkflowDeliveryEvent,
      context: Readonly<{ signal: AbortSignal }>,
    ): void | "ignored" | Promise<void | "ignored">;
  }>;
export type WorkflowRuntimeOptions = Readonly<{
  clock?: () => Date;
  ids?: Parameters<typeof createWorkflowCommandDispatch>[0]["ids"];
  validateResult?: WorkflowResultValidator;
  authorizeOperations?: WorkflowOperationsAuthorizer;
  bind(services: WorkflowServices): Readonly<Record<string, WorkflowConsumerBinding>>;
}>;
export type WorkflowServices = Readonly<{
  dispatch(request: CommandRequest, auth: AuthContext): Promise<CommandExecutionResult>;
  repository: Pick<ResourceRepository, "getState">;
  queries: QueryRepository;
  records: {
    get<T>(definition: AtomicRecordDefinition<T>, logicalKey: string): Promise<T | undefined>;
  };
  operations: Pick<ReturnType<typeof createWorkflowFailureService>, "inspect" | "replay">;
  events: {
    parse(input: unknown): JawStackEvent<Record<string, unknown>>;
    fact(input: unknown): JawStackEvent<Record<string, unknown>>;
    subscribers(eventType: string): readonly string[];
  };
}>;
export type WorkflowRuntime = WorkflowServices &
  Readonly<{
    manifest: WorkflowDefinition["manifest"];
    delivery: ReturnType<typeof createWorkflowDelivery>;
    close(options?: { timeoutMs?: number }): Promise<void>;
  }>;

export function boundedWait<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw new JawStackRuntimeError("command.rejected", "Timeout must be 1-30000 ms.");
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new JawStackRuntimeError("runtime.unavailable", "Workflow stop/close timed out.")),
      timeoutMs,
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
const bindingContext = /* @__PURE__ */ new AsyncLocalStorage<boolean>();
function createLifecycle() {
  const abort = new AbortController(),
    active = new Set<Promise<unknown>>();
  let state: "binding" | "ready" | "closing" | "closed" = "binding",
    violation = false;
  const check = () => {
    if (state === "binding" || bindingContext.getStore()) {
      violation = true;
      workflowDefinitionError("Services cannot execute during binding.");
    }
    if (state !== "ready")
      throw new JawStackRuntimeError("runtime.unavailable", "Workflow is closing or closed.");
  };
  const run = <T>(work: () => T | Promise<T>): Promise<T> => {
    check();
    let result: Promise<T>;
    try {
      result = Promise.resolve(work());
    } catch (error) {
      result = Promise.reject(error);
    }
    active.add(result);
    void result.then(
      () => active.delete(result),
      () => active.delete(result),
    );
    return result;
  };
  return {
    abort,
    active,
    run,
    check,
    ready: () => {
      if (violation) workflowDefinitionError("Binding attempted to execute a service.");
      state = "ready";
    },
    shutdown: () => {
      state = "closing";
      abort.abort();
    },
    finish: () => {
      state = "closed";
    },
    closed: () => state === "closed",
  };
}
const lifecycles = new WeakMap<object, ReturnType<typeof createLifecycle>>();
export const runtimeLifecycle = (runtime: WorkflowRuntime) => lifecycles.get(runtime)!;

// Backend adapter-author composition: all stores are required and the returned services work in full.
export function createWorkflowRuntime(
  definition: WorkflowDefinition,
  createStorage: WorkflowStorageFactory,
  options: WorkflowRuntimeOptions,
): WorkflowRuntime {
  const data = workflowDefinition(definition),
    lifecycle = createLifecycle();
  if (
    ownEntries(options).some(
      ([name]) => !["clock", "ids", "validateResult", "authorizeOperations", "bind"].includes(name),
    )
  )
    workflowDefinitionError("Unknown runtime option.");
  for (const [key, value] of ownEntries(options))
    if (
      ["clock", "bind", "authorizeOperations", "validateResult"].includes(key) &&
      value !== undefined &&
      typeof value !== "function"
    )
      workflowDefinitionError("Invalid workflow callback.");
  const { bind, ids, validateResult, authorizeOperations } = options;
  if (
    ids &&
    ownEntries(ids).some(
      ([key, value]) =>
        !["eventId", "activityId", "requestId", "correlationId", "resourceId"].includes(key) ||
        typeof value !== "function",
    )
  )
    workflowDefinitionError("Invalid workflow ID generator.");
  const clock = options.clock ?? (() => new Date());
  if (
    typeof bind !== "function" ||
    typeof createStorage !== "function" ||
    typeof clock !== "function"
  )
    workflowDefinitionError("Workflow requires synchronous storage and consumer binding.");
  const storage = createStorage({
    planner: data.planner,
    protocol: data.protocol,
    manifest: data.manifest,
    validation: Object.freeze({
      json: jsonCopy,
      resource: storedResource,
      idempotency: storedIdempotency,
      record: (collection: string, logicalKey: string, value: unknown) => {
        try {
          const row = readRecord(data.registeredRecords, collection, logicalKey, value);
          if (!data.registry.getResource(row.owner.resourceType)) invalidStored();
          return row;
        } catch {
          return invalidStored();
        }
      },
      activity: (value: unknown) => {
        try {
          const copy = jsonCopy(value, 192 * 1024);
          activitySchema.parse(copy);
          return copy as import("../index").ActivityRecord;
        } catch {
          return invalidStored();
        }
      },
      projection: (value: unknown) => {
        try {
          const copy = jsonCopy(value, 192 * 1024);
          projectionSchema.parse(copy);
          return copy as import("../index").ProjectionWrite;
        } catch {
          return invalidStored();
        }
      },
    }),
  });
  if (storage instanceof Promise) {
    void storage.catch(() => {});
    workflowDefinitionError("Storage construction must be synchronous.");
  }
  ownEntries(storage);
  for (const [port, methods] of [
    [storage.repository, ["getState"]],
    [storage.queries, ["queryProjection", "queryActivity"]],
    [storage.records, ["get"]],
    [storage.failures, ["get", "query", "commit"]],
    [storage.markers, ["check", "write"]],
  ] as const)
    if (
      !port ||
      methods.some(
        (method) => typeof (port as unknown as Record<string, unknown>)[method] !== "function",
      )
    )
      workflowDefinitionError("Missing workflow storage service.");
  if (
    typeof storage.command !== "function" ||
    (storage.close !== undefined && typeof storage.close !== "function")
  )
    workflowDefinitionError("Invalid workflow storage lifecycle.");
  const dispatch = createWorkflowCommandDispatch({
    registry: data.registry,
    source: data.manifest.source,
    persistence: storage.command,
    clock,
    ...(ids ? { ids } : {}),
    ...(validateResult ? { validateResult } : {}),
  });
  let failures!: ReturnType<typeof createWorkflowFailureService>;
  const requireResource = (name: string) => {
    if (!data.registry.getResource(name))
      throw new JawStackRuntimeError("resource.not_found", "Resource is not registered.");
  };
  const services: WorkflowServices = Object.freeze<WorkflowServices>({
    dispatch: (request, auth) => {
      try {
        return lifecycle.run(() => dispatch(request, auth));
      } catch (error) {
        if (error instanceof JawStackDefinitionError) throw error;
        return Promise.resolve({
          ok: false,
          error: { code: "runtime.unavailable", message: "Workflow is closing or closed." },
          meta: {
            requestId: request.requestId ?? randomUUID(),
            correlationId: request.correlationId ?? randomUUID(),
          },
        });
      }
    },
    repository: Object.freeze<Pick<ResourceRepository, "getState">>({
      getState: (type, id) =>
        lifecycle.run(async () => {
          requireResource(type);
          component(id);
          const value = await storage.repository.getState(type, id);
          return value === undefined ? undefined : storedResource(value, type, id);
        }),
    }),
    queries: Object.freeze<QueryRepository>({
      queryProjection: (query) =>
        lifecycle.run(() => {
          const captured = jsonCopy(query);
          requireResource(captured.projectionName.split(".")[0]!);
          if (captured.projectionName === data.manifest.operations.projection)
            throw new JawStackRuntimeError("auth.forbidden", "Use authorized workflow operations.");
          return storage.queries.queryProjection(captured);
        }),
      queryActivity: (query) =>
        lifecycle.run(() => {
          const captured = jsonCopy(query);
          requireResource(captured.resourceType);
          return storage.queries.queryActivity(captured);
        }),
    }),
    records: Object.freeze({
      get: <T>(record: AtomicRecordDefinition<T>, logicalKey: string) =>
        lifecycle.run(async () => {
          if (!data.registeredRecords.has(record))
            throw new JawStackRuntimeError(
              "command.rejected",
              "Record definition is not registered.",
            );
          utf8(logicalKey, 1024);
          const row = await storage.records.get(record.name, logicalKey);
          if (row === undefined) return undefined;
          try {
            const copy = jsonCopy(row, 64 * 1024);
            if (
              Object.keys(copy).length !== 3 ||
              Object.keys(copy.owner).length !== 2 ||
              copy.collection !== record.name
            )
              invalidStored();
            requireResource(copy.owner.resourceType);
            const resolved = resolveRecord(
              record.create(copy.value as T),
              data.registeredRecords,
              copy.owner,
            );
            if (resolved.logicalKey !== logicalKey) invalidStored();
            return jsonCopy(resolved.value) as T;
          } catch {
            return invalidStored();
          }
        }),
    }),
    operations: Object.freeze<WorkflowServices["operations"]>({
      inspect: (...args) => lifecycle.run(() => failures.inspect(...args)),
      replay: (...args) => {
        assertWorkflowWritable();
        return lifecycle.run(() => failures.replay(...args));
      },
    }),
    events: Object.freeze({
      parse: data.parse,
      fact: data.fact,
      subscribers: (type) =>
        Object.freeze(data.consumers.filter((c) => c.eventTypes.includes(type)).map((c) => c.name)),
    }),
  });
  try {
    const result = bindingContext.run(true, () => bind(services));
    if (result instanceof Promise) {
      void result.catch(() => {});
      workflowDefinitionError("Consumer binding must be synchronous.");
    }
    const entries = ownEntries(result);
    if (
      entries.length !== data.consumers.length ||
      entries.some(([name]) => !data.consumers.some((c) => c.name === name))
    )
      workflowDefinitionError("Bindings must exactly match declared consumers.");
    const bindings = new Map<string, WorkflowConsumerBinding>();
    const hooks: Record<string, FailureHooks> = Object.create(null) as Record<string, FailureHooks>;
    for (const [name, input] of entries) {
      const fields = ownEntries(input);
      if (
        !fields.some(([key, value]) => key === "handle" && typeof value === "function") ||
        fields.some(
          ([key, value]) =>
            !["handle", "reconcileFailure", "authorizeReplay"].includes(key) ||
            typeof value !== "function",
        )
      )
        workflowDefinitionError("Every consumer requires a handler and valid optional hooks.");
      const binding = Object.freeze(Object.fromEntries(fields)) as WorkflowConsumerBinding;
      bindings.set(name, binding);
      hooks[name] = Object.freeze({
        ...(binding.reconcileFailure ? { reconcileFailure: binding.reconcileFailure } : {}),
        ...(binding.authorizeReplay ? { authorizeReplay: binding.authorizeReplay } : {}),
      });
    }
    failures = createWorkflowFailureService({
      protocol: data.protocol,
      store: storage.failures,
      hooks,
      clock,
      ...(authorizeOperations ? { authorizeOperations } : {}),
    });
    const delivery = createWorkflowDelivery({
      data,
      failures,
      markers: storage.markers,
      bindings,
      clock,
      run: lifecycle.run,
      signal: lifecycle.abort.signal,
    });
    let closing: Promise<void> | undefined;
    const close = (input: { timeoutMs?: number } = {}) => {
      assertWorkflowWritable();
      if (lifecycle.closed()) return Promise.resolve();
      const timeoutMs = input.timeoutMs ?? 5000;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
        throw new JawStackRuntimeError("command.rejected", "Invalid close timeout.");
      closing ??= (async () => {
        lifecycle.shutdown();
        await boundedWait(
          Promise.all([
            Promise.allSettled([...lifecycle.active]),
            Promise.resolve().then(() => storage.close?.()),
          ]),
          timeoutMs,
        );
        lifecycle.finish();
      })().finally(() => {
        closing = undefined;
      });
      return closing;
    };
    const runtime = Object.freeze({ ...services, manifest: data.manifest, delivery, close });
    lifecycle.ready();
    lifecycles.set(runtime, lifecycle);
    return runtime;
  } catch (error) {
    lifecycle.shutdown();
    lifecycle.finish();
    throw error;
  }
}
