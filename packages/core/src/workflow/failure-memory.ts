import { isDeepStrictEqual as equal } from "node:util";
import { InMemoryRepository, JawStackDefinitionError, JawStackRuntimeError } from "../index";
import { assertFailureWritable } from "./failure-context";
import {
  failureConflict,
  type FailureProtocol,
  type WorkflowFailureStore,
} from "./failure-records";
import { memoryPhysicalKey, type createMemoryWorkflowPersistence } from "./memory";
import { workflowRecordKeys } from "./keys";
import { invalidStored } from "./stored";

const mounted = new WeakSet<object>();
export function createMemoryWorkflowFailureStore(options: {
  persistence: ReturnType<typeof createMemoryWorkflowPersistence>;
  protocol: FailureProtocol;
  maxRecords?: number;
}): WorkflowFailureStore {
  const { persistence, protocol } = options;
  const maximum = options.maxRecords ?? 1000;
  if (
    !Number.isInteger(maximum) ||
    maximum < 1 ||
    maximum > 10_000 ||
    mounted.has(persistence.failures) ||
    persistence.failures.size
  )
    throw new JawStackDefinitionError(
      "workflow.failures",
      "Invalid or already mounted memory failure store.",
    );
  mounted.add(persistence.failures);
  const { store, failures } = persistence;
  const repository = new InMemoryRepository(store);
  const get: WorkflowFailureStore["get"] = async (id) => {
    const key = memoryPhysicalKey(protocol.key(id));
    if (!failures.has(key)) return undefined;
    const row = protocol.parse(failures.get(key));
    if (row.id !== id) invalidStored();
    return row;
  };
  return Object.freeze<WorkflowFailureStore>({
    get,
    query: async (input) => repository.queryProjection(protocol.query(input)),
    commit: async (expectedVersion, input, replay) => {
      assertFailureWritable();
      const next = protocol.parse(input);
      const event = replay === undefined ? undefined : protocol.wire(replay);
      const projection = protocol.projection(next);
      const key = memoryPhysicalKey(protocol.key(next.id));
      const projectionKey = memoryPhysicalKey(
        workflowRecordKeys.projection(protocol.resourceType, projection),
      );
      await persistence.atomic(() => {
        persistence.assertPublication(0, event ? 1 : 0);
        const old = failures.has(key) ? protocol.parse(failures.get(key)) : undefined;
        if ((old?.version ?? null) !== expectedVersion) failureConflict();
        protocol.validateChange(old, next, event);
        if (!old && failures.size >= maximum)
          throw new JawStackRuntimeError(
            "runtime.unavailable",
            "Failed-delivery capacity reached.",
          );
        if (old) {
          if (!equal(store.projections.get(projectionKey), protocol.projection(old)))
            invalidStored();
        } else if (store.projections.has(projectionKey)) failureConflict();
        if (event && store.outbox.some((e) => e.eventId === event.eventId)) failureConflict();
        persistence.assertPublication(0, event ? 1 : 0);
        // No await or application callback between conditions and these three writes.
        failures.set(key, next);
        store.projections.set(projectionKey, projection);
        if (event) store.outbox.push(event);
      });
    },
  });
}
