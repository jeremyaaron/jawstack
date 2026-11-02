import {
  createMemoryWorkflowFailureStore,
  JawStackDefinitionError,
  failedDeliveryId,
  envelopeFingerprint,
  InMemoryStore,
  type WorkflowFailureRecord,
  type WorkflowFailureStore,
} from "@jawstack/core";
import { createContentStorageSpec } from "./workflow";
import { contentMemoryPersistence, createMemoryPersistence } from "./memory";
export { failureIdSchema, consumerSchema, failureSummarySchema } from "../shared/operation-views";
export { failedDeliveryId, envelopeFingerprint };
export type FailureRecord = WorkflowFailureRecord;
export type FailureStore = WorkflowFailureStore;
const protocol = (source: string) => createContentStorageSpec(source).protocol;
export const parseFailureRecord = (input: unknown, source: string) => protocol(source).parse(input);
export const replayEnvelope = (
  record: FailureRecord,
  recovery: FailureRecord["recoveries"][number],
) => protocol(record.original.source).replayEnvelope(record, recovery);
export const failureSummary = (record: FailureRecord) =>
  protocol(record.original.source).summary(record);
export const failureKey = (id: string) => {
  const key = protocol("content-operations").key(id);
  return { PK: key.partition, SK: key.sort };
};
export const failureProjection = (record: FailureRecord) =>
  protocol(record.original.source).projection(record);

const mounted = new WeakMap<object, { source: string; store: ReturnType<typeof mount> }>();
function mount(
  persistence: NonNullable<ReturnType<typeof contentMemoryPersistence>>,
  source: string,
  maxRecords?: number,
) {
  const shared = createMemoryWorkflowFailureStore({
    persistence,
    protocol: protocol(source),
    ...(maxRecords !== undefined ? { maxRecords } : {}),
  });
  return { ...shared, store: persistence.store, records: persistence.failures };
}
export function createMemoryFailureStore(options: {
  source: string;
  store?: InMemoryStore;
  maxRecords?: number;
}) {
  const store = options.store ?? new InMemoryStore();
  const persistence =
    contentMemoryPersistence(store) ?? createMemoryPersistence({ store, source: options.source });
  const previous = mounted.get(persistence.store);
  if (previous) {
    if (previous.source !== options.source)
      throw new JawStackDefinitionError(
        "content.memory",
        "Failure storage already belongs to a different source.",
      );
    return previous.store;
  }
  const result = mount(persistence, options.source, options.maxRecords);
  mounted.set(persistence.store, { source: options.source, store: result });
  return result;
}
