import { InMemoryRepository, type InMemoryStore } from "../index";
import {
  createWorkflowRuntime,
  runtimeLifecycle,
  type WorkflowRuntimeOptions,
  type WorkflowStorage,
} from "./runtime";
import { ownEntries, workflowDefinitionError, type WorkflowDefinition } from "./definition";
import { createMemoryWorkflowPersistence, memoryPhysicalKey } from "./memory";
import { createMemoryWorkflowFailureStore } from "./failure-memory";
import { createMemoryWorkflowMarkers } from "./delivery";
import { createWorkflowPump } from "./pump";
import { workflowRecordKeys } from "./keys";
import { jsonCopy } from "./validation";
import { invalidStored } from "./stored";

export type MemoryWorkflowOptions = WorkflowRuntimeOptions &
  Readonly<{
    store?: InMemoryStore;
    memory?: {
      maxJobs?: number;
      maxMarkers?: number;
      maxCollectionMarkers?: number;
      maxFailures?: number;
    };
  }>;
export function createMemoryWorkflow(
  definition: WorkflowDefinition,
  options: MemoryWorkflowOptions,
) {
  if (
    ownEntries(options).some(
      ([key]) =>
        ![
          "clock",
          "ids",
          "validateResult",
          "authorizeOperations",
          "bind",
          "store",
          "memory",
        ].includes(key),
    )
  )
    workflowDefinitionError("Unknown memory runtime option.");
  if (options.memory) ownEntries(options.memory);
  const { store: suppliedStore, memory: suppliedLimits, ...runtimeOptions } = options;
  const clock = runtimeOptions.clock ?? (() => new Date());
  const caps = {
    maxJobs: 200,
    maxMarkers: 1000,
    maxCollectionMarkers: 1000,
    maxFailures: 1000,
    ...suppliedLimits,
  };
  if (
    Object.keys(caps).some(
      (key) => !["maxJobs", "maxMarkers", "maxCollectionMarkers", "maxFailures"].includes(key),
    ) ||
    Object.values(caps).some((value) => !Number.isInteger(value) || value < 1 || value > 10000)
  )
    workflowDefinitionError("Invalid memory workflow capacity.");
  let persistence!: ReturnType<typeof createMemoryWorkflowPersistence>;
  const markers = createMemoryWorkflowMarkers(caps.maxMarkers, caps.maxCollectionMarkers);
  const runtime = createWorkflowRuntime(
    definition,
    (spec): WorkflowStorage => {
      persistence = createMemoryWorkflowPersistence({
        planner: spec.planner,
        ...(suppliedStore ? { store: suppliedStore } : {}),
      });
      const repository = new InMemoryRepository(persistence.store);
      return {
        command: persistence.factory,
        repository: persistence.repository,
        queries: repository,
        records: {
          get: async (name, key) => {
            const physical = memoryPhysicalKey(workflowRecordKeys.record(name, key));
            if (!persistence.records.has(physical)) return undefined;
            const row = persistence.records.get(physical);
            if (!row) invalidStored();
            return jsonCopy(row);
          },
        },
        failures: createMemoryWorkflowFailureStore({
          persistence,
          protocol: spec.protocol,
          maxRecords: caps.maxFailures,
        }),
        markers,
        close: () => pump.stop(),
      };
    },
    { ...runtimeOptions, clock },
  );
  const lifecycle = runtimeLifecycle(runtime);
  const pump = createWorkflowPump({
    outbox: () => persistence.store.outbox,
    parse: runtime.events.parse,
    subscribers: runtime.events.subscribers,
    delivery: runtime.delivery,
    clock,
    signal: lifecycle.abort.signal,
    run: lifecycle.run,
    check: lifecycle.check,
    maxJobs: caps.maxJobs,
    markerCounts: () => markers.inspect(clock()),
  });
  return Object.freeze({
    ...runtime,
    store: persistence.store,
    drain: pump.drain,
    drainUntilIdle: pump.drainUntilIdle,
    start: pump.start,
    inspect: pump.inspect,
  });
}
export type MemoryWorkflow = ReturnType<typeof createMemoryWorkflow>;
