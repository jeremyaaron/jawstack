import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  JawStackRuntimeError,
  InMemoryStore,
  InMemoryRepository,
  type JawStackEvent,
  type Page,
  type ProjectionRecord,
} from "@jawstack/core";
import { projectionKey } from "@jawstack/aws-runtime";
import { contentWorkers, type ContentWorkerName } from "../domain/subscriptions";
import { parseContentWire, parseContentEvent, eventIdentitySchema } from "../shared/events";
import { instantSchema, jsonBytes, versionSchema } from "../shared/validation";
import {
  failureIdSchema,
  consumerSchema,
  failureCollectionSchema as collectionSchema,
  failureRecoverySchema as recoverySchema,
} from "../shared/operation-views";
export { failureIdSchema, consumerSchema, failureSummarySchema } from "../shared/operation-views";

const recordSchema = z.strictObject({
  id: failureIdSchema,
  version: versionSchema,
  consumer: consumerSchema,
  original: z.unknown(),
  fingerprint: failureIdSchema,
  firstCollectedAt: instantSchema,
  collections: z.array(collectionSchema).min(1).max(4),
  recoveries: z.array(recoverySchema).max(3),
  resolvedGeneration: z.number().int().min(0).max(3).nullable(),
});
export type FailureRecord = z.infer<typeof recordSchema> & {
  original: ReturnType<typeof parseContentWire>;
};
export const failedDeliveryId = (consumer: ContentWorkerName, originalEventId: string) =>
  createHash("sha256")
    .update(
      JSON.stringify([consumerSchema.parse(consumer), eventIdentitySchema.parse(originalEventId)]),
    )
    .digest("hex");
export const envelopeFingerprint = (event: JawStackEvent) =>
  createHash("sha256").update(JSON.stringify(event)).digest("hex");
export function assertSubscription(
  consumer: ContentWorkerName,
  event: ReturnType<typeof parseContentEvent>,
  allowForeignRecovery = false,
) {
  consumerSchema.parse(consumer);
  if (
    !contentWorkers.find((w) => w.name === consumer)?.eventTypes.includes(event.eventType) ||
    (!allowForeignRecovery && event.recovery && event.recovery.consumer !== consumer)
  )
    throw new JawStackRuntimeError(
      "command.rejected",
      "Consumer is not an allowed destination for this fact.",
    );
}
export function parseFailureRecord(input: unknown, source: string): FailureRecord {
  const data = recordSchema.parse(input);
  const original = parseContentWire(data.original, source);
  const parsed = parseContentEvent(original, source);
  assertSubscription(data.consumer, parsed);
  if (
    "delivery" in original.payload ||
    data.id !== failedDeliveryId(data.consumer, original.eventId) ||
    data.fingerprint !== envelopeFingerprint(original) ||
    jsonBytes(data) > 128 * 1024 ||
    (data.resolvedGeneration !== null && data.resolvedGeneration > data.recoveries.length) ||
    data.collections[0]!.generation !== 0
  )
    throw new JawStackRuntimeError(
      "resource.invalid_state",
      "Invalid failed-delivery identity or bounds.",
    );
  const generations = data.collections.map((c) => c.generation);
  if (
    new Set(generations).size !== generations.length ||
    data.recoveries.some(
      (r, index) => r.generation !== index + 1 || r.eventId === original.eventId,
    ) ||
    new Set(data.recoveries.map((r) => r.eventId)).size !== data.recoveries.length ||
    new Set(data.recoveries.map((r) => r.requestId)).size !== data.recoveries.length ||
    data.collections.some(
      (c) =>
        c.generation > data.recoveries.length ||
        c.eventId !==
          (c.generation === 0 ? original.eventId : data.recoveries[c.generation - 1]!.eventId),
    )
  )
    throw new JawStackRuntimeError("resource.invalid_state", "Invalid failure recovery history.");
  return { ...data, original };
}
export function replayEnvelope(
  record: FailureRecord,
  recovery: FailureRecord["recoveries"][number],
) {
  return parseContentWire(
    {
      ...record.original,
      eventId: recovery.eventId,
      occurredAt: recovery.requestedAt,
      causationId: record.original.eventId,
      payload: {
        ...record.original.payload,
        delivery: {
          originalEventId: record.original.eventId,
          generation: recovery.generation,
          consumer: record.consumer,
          failureId: record.id,
        },
      },
    },
    record.original.source,
  );
}
export function failureSummary(record: FailureRecord) {
  const generation = record.recoveries.length;
  const collection = record.collections.find((c) => c.generation === generation);
  return {
    id: record.id,
    version: record.version,
    consumer: record.consumer,
    originalEventId: record.original.eventId,
    correlationId: record.original.correlationId,
    eventType: record.original.eventType,
    resourceType: record.original.resourceType,
    resourceId: record.original.resourceId,
    firstCollectedAt: record.firstCollectedAt,
    generation,
    status:
      record.resolvedGeneration === generation
        ? "resolved"
        : !collection
          ? "replayQueued"
          : collection.resolution === "pending"
            ? "reconciling"
            : "failed",
    resolution: collection?.resolution ?? null,
    recoveries: structuredClone(record.recoveries),
    collections: structuredClone(record.collections),
  };
}
export const failureKey = (id: string) => ({
  PK: `FAILURE#${failureIdSchema.parse(id)}`,
  SK: "DELIVERY",
});
export const failureProjection = (record: FailureRecord) => ({
  projectionName: "contentItem.failures",
  itemId: record.id,
  sort: `${record.firstCollectedAt}#${record.id}`,
  data: failureSummary(record),
});
export function validateFailureChange(
  previous: FailureRecord | undefined,
  next: FailureRecord,
  replay?: JawStackEvent,
) {
  const conflict = () => {
    throw new JawStackRuntimeError("resource.conflict", "Failure history cannot be rewritten.");
  };
  if (next.version !== (previous?.version ?? 0) + 1) conflict();
  if (previous) {
    if (
      next.id !== previous.id ||
      next.consumer !== previous.consumer ||
      next.firstCollectedAt !== previous.firstCollectedAt ||
      !isDeepStrictEqual(next.original, previous.original) ||
      next.fingerprint !== previous.fingerprint ||
      next.recoveries.length < previous.recoveries.length ||
      next.recoveries.length > previous.recoveries.length + 1 ||
      !isDeepStrictEqual(
        next.recoveries.slice(0, previous.recoveries.length),
        previous.recoveries,
      ) ||
      (previous.resolvedGeneration !== null &&
        (next.resolvedGeneration === null || next.resolvedGeneration < previous.resolvedGeneration))
    )
      conflict();
    for (const collection of previous.collections) {
      const updated = next.collections.find((c) => c.generation === collection.generation);
      if (
        !updated ||
        updated.eventId !== collection.eventId ||
        updated.collectedAt !== collection.collectedAt ||
        (collection.resolution !== "pending" && !isDeepStrictEqual(updated, collection))
      )
        conflict();
    }
  } else if (
    next.recoveries.length ||
    next.collections.length !== 1 ||
    next.collections[0]!.resolution !== "pending" ||
    next.resolvedGeneration !== null
  )
    conflict();
  const added = next.recoveries.length > (previous?.recoveries.length ?? 0);
  if (
    added
      ? !replay || !isDeepStrictEqual(replay, replayEnvelope(next, next.recoveries.at(-1)!))
      : replay !== undefined
  )
    conflict();
}
export interface FailureStore {
  get(id: string): Promise<FailureRecord | undefined>;
  query(options?: { limit?: number; cursor?: string }): Promise<Page<ProjectionRecord>>;
  commit(
    expectedVersion: number | null,
    record: FailureRecord,
    replay?: JawStackEvent,
  ): Promise<void>;
}
export function failureQuery(input: { limit?: number; cursor?: string } = {}) {
  const parsed = z
    .strictObject({
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().min(1).max(8192).optional(),
    })
    .parse(input);
  return {
    projectionName: "contentItem.failures",
    limit: parsed.limit ?? 50,
    ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
  };
}
export function createMemoryFailureStore(options: {
  source: string;
  store?: InMemoryStore;
  maxRecords?: number;
}) {
  const store = options.store ?? new InMemoryStore();
  const repository = new InMemoryRepository(store);
  const records = new Map<string, FailureRecord>();
  const maximum = options.maxRecords ?? 1000;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 10_000)
    throw new Error("Invalid failed-delivery capacity.");
  const api: FailureStore = {
    get: async (id) => {
      failureIdSchema.parse(id);
      const row = records.get(id);
      return row && parseFailureRecord(structuredClone(row), options.source);
    },
    query: async (input) => repository.queryProjection(failureQuery(input)),
    commit: async (expectedVersion, input, replay) => {
      const next = parseFailureRecord(input, options.source);
      const old = records.get(next.id);
      if ((old?.version ?? null) !== expectedVersion)
        throw new JawStackRuntimeError("resource.conflict", "Failed-delivery version changed.");
      validateFailureChange(old, next, replay);
      if (!old && records.size >= maximum)
        throw new JawStackRuntimeError("runtime.unavailable", "Failed-delivery capacity reached.");
      const projection = failureProjection(next);
      const key = JSON.stringify(projectionKey({ ...projection, resourceType: "contentItem" }));
      if (
        (!old && store.projections.has(key)) ||
        (replay && store.outbox.some((e) => e.eventId === replay.eventId))
      )
        throw new JawStackRuntimeError(
          "resource.conflict",
          "Failure auxiliary record already exists.",
        );
      const staged = structuredClone({ next, projection, replay });
      // Commit recovery state, its view, and any replay together, without yielding.
      records.set(next.id, staged.next);
      store.projections.set(key, staged.projection);
      if (staged.replay) store.outbox.push(staged.replay);
    },
  };
  return { ...api, records, store };
}
