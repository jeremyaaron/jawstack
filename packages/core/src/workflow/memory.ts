import {
  InMemoryStore,
  JawStackDefinitionError,
  JawStackRuntimeError,
  type ProjectionRecord,
  type ResourceRepository,
} from "../index";
import type { WorkflowCommitPlan, WorkflowCommitPlanner } from "./commit-plan";
import { projectionSchema } from "./commit-plan";
import { assertWorkflowWritable } from "./command-context";
import type { WorkflowPersistenceFactory } from "./command-runtime";
import { workflowRecordKeys, type WorkflowCommandScope, type WorkflowRecordKey } from "./keys";
import {
  coreIdempotency,
  invalidStored,
  storedIdempotency,
  storedResource,
  type StoredWorkflowIdempotency,
} from "./stored";
import { component, freeze, instant, jsonCopy, workflowCommitLimits } from "./validation";

// Retain Content's backing-map encoding for domain-owned projection writers; no SDK types.
export const memoryPhysicalKey = (key: WorkflowRecordKey) =>
  JSON.stringify({ PK: key.partition, SK: key.sort });
const resourceKey = (type: string, id: string) => `${type}\u0000${id}`;
const ownership = new WeakSet<InMemoryStore>();
type Auxiliary = {
  collection: string;
  owner: { resourceType: string; resourceId: string };
  value: unknown;
};

export function createMemoryWorkflowPersistence(options: {
  planner: WorkflowCommitPlanner;
  store?: InMemoryStore;
}) {
  const planner = options.planner,
    store = options.store ?? new InMemoryStore();
  if (
    ownership.has(store) ||
    store.resources.size ||
    store.activity.length ||
    store.outbox.length ||
    store.projections.size ||
    store.idempotency.size
  )
    throw new JawStackDefinitionError(
      "workflow.memory",
      "Workflow memory storage must be empty and exclusively owned.",
    );
  ownership.add(store);
  const resources = store.resources,
    activity = store.activity,
    outbox = store.outbox,
    projections = store.projections;
  const idempotency = new Map<string, StoredWorkflowIdempotency>();
  const records = new Map<string, Auxiliary>();
  let tail = Promise.resolve();
  const readState = (type: string, id: string) => {
    component(type);
    component(id);
    const key = resourceKey(type, id);
    const value = resources.get(key);
    if (value === undefined && resources.has(key)) invalidStored();
    return value === undefined ? undefined : storedResource(value, type, id);
  };
  const getState: ResourceRepository["getState"] = async (type, id) => readState(type, id);
  const readIdempotency = (scope: WorkflowCommandScope, key: string, now: string) => {
    const physicalKey = memoryPhysicalKey(workflowRecordKeys.idempotency(scope, key));
    const existing = idempotency.get(physicalKey);
    if (existing === undefined && idempotency.has(physicalKey)) invalidStored();
    if (existing === undefined) return undefined;
    const row = storedIdempotency(existing, scope, key);
    return row.expiresAt <= Math.floor(Date.parse(now) / 1000)
      ? undefined
      : coreIdempotency(
          { key: row.key, fingerprint: row.fingerprint, response: row.response },
          key,
        );
  };
  const conflict = (kind: string): never => {
    throw new JawStackRuntimeError(
      kind === "idempotency" ? "idempotency.conflict" : "resource.conflict",
      "An atomic workflow condition failed.",
    );
  };
  const commit = async (input: WorkflowCommitPlan) => {
    assertWorkflowWritable();
    const plan = planner.validate(input);
    const writes = structuredClone(plan.actions);
    const previous = tail;
    let unlock!: () => void;
    tail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      // Conditions and publication below never yield. Patch only touched entries, not a stale store clone.
      if (
        store.resources !== resources ||
        store.activity !== activity ||
        store.outbox !== outbox ||
        store.projections !== projections ||
        [resources, projections, idempotency, records].some(
          (map) =>
            Object.getPrototypeOf(map) !== Map.prototype ||
            map.set !== Map.prototype.set ||
            map.delete !== Map.prototype.delete ||
            map.get !== Map.prototype.get ||
            map.has !== Map.prototype.has,
        ) ||
        [activity, outbox].some(
          (array) =>
            Object.getPrototypeOf(array) !== Array.prototype || array.push !== Array.prototype.push,
        ) ||
        !Object.isExtensible(activity) ||
        !Object.isExtensible(outbox) ||
        !Object.getOwnPropertyDescriptor(activity, "length")?.writable ||
        !Object.getOwnPropertyDescriptor(outbox, "length")?.writable ||
        activity.length + writes.filter((w) => w.kind === "activity").length > 0xffffffff ||
        outbox.length + writes.filter((w) => w.kind === "outbox").length > 0xffffffff
      )
        invalidStored();
      const idem = writes.find((w) => w.kind === "idempotency")!;
      if (idem.kind !== "idempotency") invalidStored();
      if (readIdempotency(plan.scope, idem.value.key, plan.now)) conflict("idempotency");
      for (const write of writes) {
        const key = memoryPhysicalKey(write.key);
        if (write.kind === "resource") {
          const current = readState(write.value.resourceType, write.value.resourceId);
          if (
            write.condition.kind === "absent"
              ? current !== undefined
              : current?.version !== write.condition.expectedVersion
          )
            conflict(write.kind);
        } else if (write.kind === "activity") {
          if (activity.some((row) => memoryPhysicalKey(workflowRecordKeys.activity(row)) === key))
            conflict(write.kind);
        } else if (write.kind === "outbox") {
          if (outbox.some((row) => row.eventId === write.value.eventId)) conflict(write.kind);
        } else if (write.kind === "record") {
          if (records.has(key)) conflict(write.kind);
        } else if (write.kind === "projection" || write.kind === "projectionDelete") {
          const old = projections.get(key);
          if (old === undefined && projections.has(key)) invalidStored();
          if (old !== undefined) {
            try {
              const copy = jsonCopy(old, workflowCommitLimits.recordBytes);
              if (
                !projectionSchema.safeParse(copy).success ||
                copy.delete === true ||
                memoryPhysicalKey(workflowRecordKeys.projection(plan.scope.resourceType, copy)) !==
                  key
              )
                invalidStored();
            } catch {
              invalidStored();
            }
          }
        }
      }
      for (const write of writes) {
        const key = memoryPhysicalKey(write.key);
        switch (write.kind) {
          case "resource":
            resources.set(
              resourceKey(write.value.resourceType, write.value.resourceId),
              write.value,
            );
            break;
          case "activity":
            activity.push(write.value);
            break;
          case "outbox":
            outbox.push(write.value);
            break;
          case "projection":
            projections.set(key, write.value as ProjectionRecord);
            break;
          case "projectionDelete":
            projections.delete(key);
            break;
          case "idempotency":
            idempotency.set(key, write.value);
            break;
          case "record":
            records.set(key, {
              collection: write.collection,
              owner: write.owner,
              value: write.value,
            });
            break;
        }
      }
    } finally {
      unlock();
    }
  };
  const factory: WorkflowPersistenceFactory = (inputScope, inputTime) => {
    const scope = freeze(jsonCopy(inputScope));
    if (
      Object.keys(scope).length !== 3 ||
      Object.keys(scope).some((key) => !["resourceType", "commandName", "subject"].includes(key))
    )
      throw new JawStackRuntimeError("command.rejected", "Invalid workflow command scope.");
    component(scope.resourceType);
    component(scope.commandName);
    component(scope.subject);
    const now = instant(new Date(inputTime.getTime()).toISOString());
    return {
      repository: {
        getState,
        getIdempotency: async (key) => readIdempotency(scope, component(key), now),
      },
      unitOfWork: {
        commit: async (input) => {
          assertWorkflowWritable();
          await commit(planner.plan({ scope, now }, input));
        },
      },
    };
  };
  return Object.freeze({
    store,
    factory,
    commit,
    repository: Object.freeze({ getState }),
    idempotency,
    records,
  });
}
