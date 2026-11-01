import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  JawStackRuntimeError,
  type AuthContext,
  type ResourceRepository,
  type JawStackEvent,
} from "@jawstack/core";
import { contentStateSchema, publicationRequestSchema } from "../shared/contracts";
import { parseContentEvent, parseContentWire } from "../shared/events";
import { editorIds } from "../shared/identities";
import { idSchema } from "../shared/validation";
import { failureCollectorIdentity } from "../domain/publication-commands";
import type { ContentWorkerName } from "../domain/subscriptions";
import {
  assertSubscription,
  failedDeliveryId,
  failureIdSchema,
  envelopeFingerprint,
  failureSummary,
  replayEnvelope,
  type FailureRecord,
  type FailureStore,
} from "./failure-records";
import type { createContentDispatch } from "./dispatch";

export type RecoveryFaultPoint = "afterRecord" | "afterReconcile" | "afterReplayCommit";
export function createFailureService(options: {
  store: FailureStore;
  repository: ResourceRepository;
  dispatch: ReturnType<typeof createContentDispatch>;
  source: string;
  clock?: () => Date;
  fault?: (point: RecoveryFaultPoint) => void | Promise<void>;
}) {
  const clock = options.clock ?? (() => new Date());
  const editor = (auth: AuthContext) => {
    if (
      !editorIds.includes(auth.subject as (typeof editorIds)[number]) ||
      !auth.roles.includes("editor") ||
      !["dev", "test"].includes(auth.mode)
    )
      throw new JawStackRuntimeError(
        "auth.forbidden",
        "A resolved local editor is required for recovery.",
      );
    return auth.subject as (typeof editorIds)[number];
  };
  const update = async (
    id: string,
    decide: (
      old: FailureRecord | undefined,
    ) => { record: FailureRecord; replay?: JawStackEvent } | undefined,
  ) => {
    failureIdSchema.parse(id);
    for (let retry = 0; retry < 3; retry++) {
      const old = await options.store.get(id);
      const change = decide(old);
      if (!change) return old!;
      try {
        await options.store.commit(old?.version ?? null, change.record, change.replay);
        return change.record;
      } catch (error) {
        if (
          !(error instanceof JawStackRuntimeError) ||
          !["resource.conflict", "runtime.unavailable"].includes(error.code)
        )
          throw error;
      }
    }
    throw new JawStackRuntimeError(
      "runtime.unavailable",
      "Failed-delivery update retry budget exhausted.",
    );
  };
  const authorize = async (consumer: ContentWorkerName, input: unknown) => {
    const wire = parseContentWire(input, options.source);
    const event = parseContentEvent(wire, options.source);
    assertSubscription(consumer, event);
    if (!event.recovery)
      throw new JawStackRuntimeError(
        "command.rejected",
        "A recorded targeted recovery is required.",
      );
    const record = await options.store.get(event.recovery.failureId);
    const recovery = record?.recoveries[event.recovery.generation - 1];
    if (
      !record ||
      record.consumer !== consumer ||
      !recovery ||
      !isDeepStrictEqual(wire, replayEnvelope(record, recovery))
    )
      throw new JawStackRuntimeError(
        "command.rejected",
        "Replay does not match a durable recovery request.",
      );
    return { record, generation: recovery.generation };
  };
  const reconcile = async (record: FailureRecord) => {
    if (record.consumer !== "publishContent") return "notApplicable" as const;
    const request = publicationRequestSchema.parse(record.original.payload);
    for (let retry = 0; retry < 3; retry++) {
      const row = await options.repository.getState("contentItem", request.contentId);
      if (!row) return "superseded" as const;
      const state = contentStateSchema.parse(row.state);
      const publication = state.publication;
      if (
        row.resourceType !== "contentItem" ||
        row.resourceId !== request.contentId ||
        state.contentId !== request.contentId
      )
        throw new JawStackRuntimeError(
          "resource.invalid_state",
          "Invalid publication reconciliation authority.",
        );
      if (
        !publication ||
        publication.intent.publicationId !== request.publicationId ||
        publication.generation !== request.generation
      )
        return "superseded" as const;
      if (!isDeepStrictEqual(publication.intent, request.intent))
        throw new JawStackRuntimeError(
          "command.validation",
          "Failed publication fact differs from frozen authority.",
        );
      if (publication.phase === "succeeded") return "succeeded" as const;
      if (publication.phase === "failed") return "failed" as const;
      if (publication.phase === "stalled")
        return publication.deliveryFailure!.failureId === record.id
          ? ("stalled" as const)
          : ("superseded" as const);
      if (publication.claim) {
        if (publication.lastAttempt!.sourceEventId !== record.original.eventId)
          return "superseded" as const;
        if (Date.parse(publication.claim.leaseUntil) > clock().getTime())
          throw new JawStackRuntimeError(
            "resource.conflict",
            "Failure collection awaits the live publication claim.",
          );
      }
      const result = await options.dispatch(
        {
          resourceType: "contentItem",
          resourceId: request.contentId,
          commandName: "reconcilePublicationFailure",
          input: {
            expectedVersion: row.version,
            publicationId: request.publicationId,
            generation: request.generation,
            sourceEventId: record.original.eventId,
            failureId: record.id,
          },
          idempotencyKey: `reconcile:${record.id}:${row.version}`,
          requestId: record.original.eventId,
          correlationId: record.original.correlationId,
          requestContext: {},
        },
        {
          subject: failureCollectorIdentity.subject,
          roles: [failureCollectorIdentity.role],
          mode: "dev",
          claims: {},
        },
      );
      if (result.ok) return "stalled" as const;
      if (result.error.code !== "resource.conflict")
        throw new JawStackRuntimeError(result.error.code, result.error.message);
    }
    throw new JawStackRuntimeError(
      "resource.conflict",
      "Publication reconciliation retry budget exhausted.",
    );
  };
  return {
    authorize,
    validateCollection: async (consumer: ContentWorkerName, input: unknown) => {
      const wire = parseContentWire(input, options.source);
      const event = parseContentEvent(wire, options.source);
      assertSubscription(consumer, event);
      if (event.recovery) {
        await authorize(consumer, wire);
        return;
      }
      if (event.originalEventId !== event.eventId)
        throw new JawStackRuntimeError(
          "command.rejected",
          "Unrecorded replay cannot be collected.",
        );
      const previous = await options.store.get(failedDeliveryId(consumer, event.eventId));
      if (previous && !isDeepStrictEqual(previous.original, wire))
        throw new JawStackRuntimeError("resource.conflict", "Failed event identity was reused.");
    },
    complete: async (consumer: ContentWorkerName, input: unknown) => {
      const { record, generation } = await authorize(consumer, input);
      await update(record.id, (old) => {
        if (!old || (old.resolvedGeneration !== null && old.resolvedGeneration >= generation))
          return undefined;
        return { record: { ...old, version: old.version + 1, resolvedGeneration: generation } };
      });
    },
    collect: async (consumer: ContentWorkerName, input: unknown) => {
      const wire = parseContentWire(input, options.source);
      const event = parseContentEvent(wire, options.source);
      assertSubscription(consumer, event);
      const generation = event.recovery?.generation ?? 0;
      const authorized = event.recovery ? await authorize(consumer, wire) : undefined;
      if (!authorized && event.originalEventId !== event.eventId)
        throw new JawStackRuntimeError(
          "command.rejected",
          "Unrecorded replay cannot be collected.",
        );
      const id = authorized?.record.id ?? failedDeliveryId(consumer, event.eventId);
      const record = await update(id, (old) => {
        if (old) {
          if (!authorized && (!isDeepStrictEqual(old.original, wire) || old.consumer !== consumer))
            throw new JawStackRuntimeError(
              "resource.conflict",
              "Failed event identity was reused.",
            );
          if (old.collections.some((c) => c.generation === generation)) return undefined;
          return {
            record: {
              ...old,
              version: old.version + 1,
              collections: [
                ...old.collections,
                {
                  generation,
                  eventId: event.eventId,
                  collectedAt: clock().toISOString(),
                  reconciledAt: null,
                  resolution: "pending",
                },
              ],
            },
          };
        }
        if (authorized || generation !== 0)
          throw new JawStackRuntimeError(
            "resource.invalid_state",
            "Original failure record disappeared.",
          );
        const at = clock().toISOString();
        return {
          record: {
            id,
            version: 1,
            consumer,
            original: wire,
            fingerprint: envelopeFingerprint(wire),
            firstCollectedAt: at,
            collections: [
              {
                generation: 0,
                eventId: wire.eventId,
                collectedAt: at,
                reconciledAt: null,
                resolution: "pending",
              },
            ],
            recoveries: [],
            resolvedGeneration: null,
          },
        };
      });
      await options.fault?.("afterRecord");
      if (record.collections.find((c) => c.generation === generation)!.resolution !== "pending")
        return failureSummary(record);
      const resolution = await reconcile(record);
      await options.fault?.("afterReconcile");
      const completed = await update(id, (old) => {
        if (!old)
          throw new JawStackRuntimeError("resource.invalid_state", "Failure record disappeared.");
        if (old.collections.find((c) => c.generation === generation)!.resolution !== "pending")
          return undefined;
        return {
          record: {
            ...old,
            version: old.version + 1,
            collections: old.collections.map((c) =>
              c.generation === generation
                ? { ...c, reconciledAt: clock().toISOString(), resolution }
                : c,
            ),
            resolvedGeneration: ["succeeded", "superseded"].includes(resolution)
              ? Math.max(old.resolvedGeneration ?? 0, generation)
              : old.resolvedGeneration,
          },
        };
      });
      return failureSummary(completed);
    },
    inspect: async (
      auth: AuthContext,
      input: { id?: string; limit?: number; cursor?: string } = {},
    ) => {
      editor(auth);
      if (input.id) {
        const record = await options.store.get(failureIdSchema.parse(input.id));
        if (!record)
          throw new JawStackRuntimeError("resource.not_found", "Failed delivery was not found.");
        return failureSummary(record);
      }
      return options.store.query({
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
    },
    replay: async (id: string, auth: AuthContext, requestId: string) => {
      const actor = editor(auth);
      idSchema.parse(requestId);
      const next = await update(failureIdSchema.parse(id), (old) => {
        if (!old)
          throw new JawStackRuntimeError("resource.not_found", "Failed delivery was not found.");
        if (old.consumer === "publishContent")
          throw new JawStackRuntimeError(
            "command.rejected",
            "Use the editor retryPublication command for publication recovery.",
          );
        if (old.recoveries.some((r) => r.requestId === requestId)) return undefined;
        if (old.resolvedGeneration === old.recoveries.length)
          throw new JawStackRuntimeError("command.rejected", "Delivery is already resolved.");
        const latest = old.collections.find((c) => c.generation === old.recoveries.length);
        if (!latest) return undefined; // A durable replay is already queued; do not burn another cycle.
        if (latest.resolution === "pending")
          throw new JawStackRuntimeError(
            "resource.conflict",
            "Failure reconciliation is incomplete.",
          );
        if (old.recoveries.length >= 3)
          throw new JawStackRuntimeError("command.rejected", "Manual recovery budget exhausted.");
        const recovery = {
          generation: old.recoveries.length + 1,
          eventId: randomUUID(),
          requestedAt: clock().toISOString(),
          requestedBy: actor,
          requestId,
        };
        const record = {
          ...old,
          version: old.version + 1,
          recoveries: [...old.recoveries, recovery],
        };
        return { record, replay: replayEnvelope(record, recovery) };
      });
      await options.fault?.("afterReplayCommit");
      return failureSummary(next);
    },
  };
}
