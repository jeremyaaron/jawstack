import { createHash } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import {
  JawStackDefinitionError,
  JawStackRuntimeError,
  type JawStackEvent,
  type Page,
  type ProjectionRecord,
} from "../index";
import { workflowRecordKeys } from "./keys";
import { invalidStored } from "./stored";
import { component, freeze, instant, jsonCopy, synchronous } from "./validation";

const identity = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
export const failureIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const at = z.string().refine((v) => {
  try {
    instant(v);
    return true;
  } catch {
    return false;
  }
});
const generation = z.number().int().min(0).max(3);
const collectionSchema = z
  .strictObject({
    generation,
    eventId: identity,
    collectedAt: at,
    reconciledAt: at.nullable(),
    resolution: z.enum([
      "pending",
      "notApplicable",
      "stalled",
      "failed",
      "superseded",
      "succeeded",
    ]),
  })
  .refine(
    (v) =>
      (v.resolution === "pending") === (v.reconciledAt === null) &&
      (v.reconciledAt === null || v.reconciledAt >= v.collectedAt),
  );
const recoverySchema = z.strictObject({
  generation: z.number().int().min(1).max(3),
  eventId: identity,
  requestedAt: at,
  requestedBy: identity,
  requestId: z.uuid(),
});
export const recoveryMetadataSchema = z.strictObject({
  originalEventId: identity,
  generation: z.number().int().min(1).max(3),
  consumer: identity,
  failureId: failureIdSchema,
});
const recordSchema = z.strictObject({
  id: failureIdSchema,
  version: z.number().int().positive().safe(),
  consumer: identity,
  original: z.unknown(),
  fingerprint: failureIdSchema,
  firstCollectedAt: at,
  collections: z.array(collectionSchema).min(1).max(4),
  recoveries: z.array(recoverySchema).max(3),
  resolvedGeneration: generation.nullable(),
});
const summarySchema = recordSchema
  .omit({ original: true, fingerprint: true, resolvedGeneration: true })
  .extend({
    originalEventId: identity,
    correlationId: identity,
    eventType: identity,
    resourceType: identity,
    resourceId: identity,
    generation,
    status: z.enum(["resolved", "replayQueued", "reconciling", "failed"]),
    resolution: collectionSchema.shape.resolution.nullable(),
  });
const wireSchema = z.strictObject({
  envelopeVersion: z.literal(1),
  eventId: identity,
  eventType: identity,
  schemaVersion: z.number().int().positive().safe(),
  source: z.string().min(1).max(200),
  resourceType: identity,
  resourceId: identity,
  actor: z
    .strictObject({ subject: identity, displayName: z.string().max(200).optional() })
    .optional(),
  correlationId: identity,
  causationId: identity.optional(),
  occurredAt: at,
  payload: z.record(z.string(), z.unknown()),
});
export type FailureRecord = Omit<z.infer<typeof recordSchema>, "original"> & {
  original: JawStackEvent<Record<string, unknown>>;
};
export type FailureSummary = z.infer<typeof summarySchema>;
export type FailureResolution = Exclude<
  FailureRecord["collections"][number]["resolution"],
  "pending"
>;
export type FailureConsumer = Readonly<{
  name: string;
  eventTypes: readonly string[];
  recovery: "replay" | "application";
}>;
export interface WorkflowFailureStore {
  get(id: string): Promise<FailureRecord | undefined>;
  query(input?: { limit?: number; cursor?: string }): Promise<Page<ProjectionRecord>>;
  commit(
    expectedVersion: number | null,
    record: FailureRecord,
    replay?: JawStackEvent,
  ): Promise<void>;
}
export const envelopeFingerprint = (event: JawStackEvent) =>
  createHash("sha256").update(JSON.stringify(event)).digest("hex");
export const failedDeliveryId = (consumer: string, originalEventId: string) =>
  createHash("sha256")
    .update(JSON.stringify([component(consumer), component(originalEventId)]))
    .digest("hex");
export const failureConflict = (): never => {
  throw new JawStackRuntimeError(
    "resource.conflict",
    "Failure history changed or cannot be rewritten.",
  );
};

// Internal contract, reused by memory now and by the Dynamo adapter in Phase 5.
export function createFailureProtocol(options: {
  source: string;
  resourceType: string;
  projectionName: string;
  consumers: readonly FailureConsumer[];
  eventBytes?: number;
  validateEvent: (event: JawStackEvent<Record<string, unknown>>) => void;
  normalizePayload?: (event: JawStackEvent<Record<string, unknown>>) => Record<string, unknown>;
}) {
  const { source, resourceType, projectionName, validateEvent, normalizePayload } = options;
  const eventBytes = options.eventBytes ?? 80 * 1024;
  const consumers = freeze(jsonCopy(options.consumers));
  const configSchema = z
    .array(
      z.strictObject({
        name: identity,
        eventTypes: z.array(identity).min(1),
        recovery: z.enum(["replay", "application"]),
      }),
    )
    .min(1);
  if (
    !configSchema.safeParse(consumers).success ||
    new Set(consumers.map((c) => c.name)).size !== consumers.length ||
    consumers.some((c) => new Set(c.eventTypes).size !== c.eventTypes.length) ||
    typeof source !== "string" ||
    !source.trim() ||
    source.length > 200 ||
    typeof validateEvent !== "function" ||
    !Number.isInteger(eventBytes) ||
    eventBytes < 1 ||
    eventBytes > 80 * 1024 ||
    !projectionName.startsWith(`${resourceType}.`)
  )
    throw new JawStackDefinitionError(
      "workflow.failures",
      "Invalid failure protocol configuration.",
    );
  workflowRecordKeys.projection(resourceType, { projectionName, itemId: "check", sort: "check" });
  const consumer = (name: string) => {
    const found = consumers.find((c) => c.name === name);
    if (!found) throw new JawStackRuntimeError("command.rejected", "Consumer is not registered.");
    return found;
  };
  const wire = (input: unknown): JawStackEvent<Record<string, unknown>> => {
    try {
      const envelope = wireSchema.parse(jsonCopy(input, 128 * 1024));
      if (envelope.source !== source) throw new Error();
      const { delivery, ...rawPayload } = envelope.payload;
      const payload = normalizePayload
        ? jsonCopy(
            synchronous(
              normalizePayload(
                freeze(jsonCopy({ ...envelope, payload: rawPayload })) as JawStackEvent<
                  Record<string, unknown>
                >,
              ),
            ),
            eventBytes,
          )
        : rawPayload;
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        "delivery" in payload
      )
        throw new Error();
      jsonCopy(payload, eventBytes);
      jsonCopy(envelope.payload, eventBytes + 512);
      const metadata = delivery === undefined ? undefined : recoveryMetadataSchema.parse(delivery);
      if (metadata && consumer(metadata.consumer).recovery !== "replay") throw new Error();
      const { actor, causationId, ...base } = envelope;
      const event: JawStackEvent<Record<string, unknown>> = {
        ...base,
        ...(actor
          ? {
              actor: {
                subject: actor.subject,
                ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
              },
            }
          : {}),
        ...(causationId === undefined ? {} : { causationId }),
        payload: { ...payload, ...(metadata ? { delivery: metadata } : {}) },
      };
      const checked = synchronous(validateEvent(freeze(jsonCopy({ ...event, payload }))));
      if (checked !== undefined) throw new Error();
      return event;
    } catch {
      throw new JawStackRuntimeError("command.validation", "Invalid workflow fact envelope.");
    }
  };
  const subscription = (name: string, event: JawStackEvent) => {
    if (!consumer(name).eventTypes.includes(event.eventType))
      throw new JawStackRuntimeError(
        "command.rejected",
        "Consumer is not subscribed to this fact.",
      );
  };
  const key = (id: string) => ({
    partition: `FAILURE#${failureIdSchema.parse(id)}`,
    sort: "DELIVERY",
  });
  const parse = (input: unknown): FailureRecord => {
    try {
      const data = recordSchema.parse(jsonCopy(input, 128 * 1024));
      const original = wire(data.original);
      subscription(data.consumer, original);
      const result = { ...data, original };
      jsonCopy(
        { PK: key(data.id).partition, SK: "DELIVERY", itemKind: "APP_FAILURE", ...result },
        128 * 1024,
      );
      if (
        "delivery" in original.payload ||
        data.id !== failedDeliveryId(data.consumer, original.eventId) ||
        data.fingerprint !== envelopeFingerprint(original) ||
        data.firstCollectedAt !== data.collections[0]!.collectedAt ||
        (data.resolvedGeneration !== null && data.resolvedGeneration > data.recoveries.length) ||
        new Set(data.recoveries.map((r) => r.eventId)).size !== data.recoveries.length ||
        new Set(data.recoveries.map((r) => r.requestId)).size !== data.recoveries.length ||
        data.recoveries.some(
          (r, i) =>
            r.generation !== i + 1 ||
            r.eventId === original.eventId ||
            !data.collections[i] ||
            ["pending", "succeeded", "superseded"].includes(data.collections[i]!.resolution) ||
            r.requestedAt < data.collections[i]!.reconciledAt! ||
            r.requestedAt < (i ? data.recoveries[i - 1]!.requestedAt : data.firstCollectedAt),
        ) ||
        data.collections.some(
          (c, i) =>
            c.generation !== i ||
            c.generation > data.recoveries.length ||
            c.eventId !== (i === 0 ? original.eventId : data.recoveries[i - 1]!.eventId) ||
            c.collectedAt <
              (i === 0 ? data.firstCollectedAt : data.recoveries[i - 1]!.requestedAt) ||
            (["succeeded", "superseded"].includes(c.resolution) &&
              (data.resolvedGeneration === null || data.resolvedGeneration < c.generation)),
        )
      )
        invalidStored();
      return result;
    } catch {
      return invalidStored();
    }
  };
  const replayEnvelope = (record: FailureRecord, recovery: FailureRecord["recoveries"][number]) =>
    wire({
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
    });
  const summary = (record: FailureRecord): FailureSummary => {
    const generation = record.recoveries.length,
      collection = record.collections.find((c) => c.generation === generation);
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
      recoveries: jsonCopy(record.recoveries),
      collections: jsonCopy(record.collections),
    };
  };
  const parseSummary = (input: unknown): FailureSummary => {
    try {
      const data = summarySchema.parse(jsonCopy(input, 128 * 1024));
      subscription(data.consumer, { eventType: data.eventType } as JawStackEvent);
      const latest = data.collections.find((c) => c.generation === data.generation);
      if (
        failedDeliveryId(data.consumer, data.originalEventId) !== data.id ||
        data.generation !== data.recoveries.length ||
        data.collections.some(
          (c, i) =>
            c.generation !== i ||
            c.generation > data.generation ||
            c.eventId !== (i === 0 ? data.originalEventId : data.recoveries[i - 1]!.eventId),
        ) ||
        data.resolution !== (latest?.resolution ?? null) ||
        (data.status !== "resolved" &&
          data.status !==
            (!latest ? "replayQueued" : latest.resolution === "pending" ? "reconciling" : "failed"))
      )
        invalidStored();
      return data;
    } catch {
      return invalidStored();
    }
  };
  const projection = (record: FailureRecord): ProjectionRecord => ({
    projectionName,
    itemId: record.id,
    sort: `${record.firstCollectedAt}#${record.id}`,
    data: summary(record),
  });
  const query = (input: { limit?: number; cursor?: string } = {}) => {
    const data = z
      .strictObject({
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).max(4096).optional(),
      })
      .parse(input);
    return {
      projectionName,
      limit: data.limit ?? 50,
      ...(data.cursor ? { cursor: data.cursor } : {}),
    };
  };
  const validateChange = (
    previous: FailureRecord | undefined,
    next: FailureRecord,
    replay?: JawStackEvent,
  ) => {
    if (next.version !== (previous?.version ?? 0) + 1) failureConflict();
    if (!previous) {
      if (
        next.recoveries.length ||
        next.collections.length !== 1 ||
        next.collections[0]!.resolution !== "pending" ||
        next.resolvedGeneration !== null
      )
        failureConflict();
    } else {
      if (
        next.id !== previous.id ||
        next.consumer !== previous.consumer ||
        next.firstCollectedAt !== previous.firstCollectedAt ||
        !equal(next.original, previous.original) ||
        next.fingerprint !== previous.fingerprint ||
        next.recoveries.length < previous.recoveries.length ||
        next.recoveries.length > previous.recoveries.length + 1 ||
        !equal(next.recoveries.slice(0, previous.recoveries.length), previous.recoveries) ||
        next.collections.length < previous.collections.length ||
        next.collections.length > previous.collections.length + 1 ||
        (previous.resolvedGeneration !== null &&
          (next.resolvedGeneration === null ||
            next.resolvedGeneration < previous.resolvedGeneration))
      )
        failureConflict();
      for (const collection of previous.collections) {
        const updated = next.collections.find((c) => c.generation === collection.generation);
        if (
          !updated ||
          updated.eventId !== collection.eventId ||
          updated.collectedAt !== collection.collectedAt ||
          (collection.resolution !== "pending" && !equal(updated, collection))
        )
          failureConflict();
      }
      if (
        next.collections.length > previous.collections.length &&
        (next.collections.at(-1)!.resolution !== "pending" ||
          next.collections.at(-1)!.generation !== previous.recoveries.length)
      )
        failureConflict();
    }
    const added = next.recoveries.length > (previous?.recoveries.length ?? 0);
    if (added) {
      const latest = previous?.collections.find((c) => c.generation === previous.recoveries.length);
      if (
        !previous ||
        !latest ||
        latest.resolution === "pending" ||
        previous.resolvedGeneration === previous.recoveries.length ||
        consumer(next.consumer).recovery !== "replay" ||
        !equal(next.collections, previous.collections) ||
        next.resolvedGeneration !== previous.resolvedGeneration ||
        !replay ||
        !equal(wire(replay), replayEnvelope(next, next.recoveries.at(-1)!))
      )
        failureConflict();
    } else if (replay !== undefined) failureConflict();
  };
  return Object.freeze({
    consumer,
    wire,
    subscription,
    key,
    parse,
    replayEnvelope,
    summary,
    parseSummary,
    projection,
    query,
    validateChange,
    resourceType,
    projectionName,
  });
}
export type FailureProtocol = ReturnType<typeof createFailureProtocol>;
