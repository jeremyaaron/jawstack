import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import {
  JawStackDefinitionError,
  JawStackRuntimeError,
  type AuthContext,
  type JawStackEvent,
  type Page,
} from "../index";
import { validateReadOnly } from "./command-context";
import { assertFailureWritable, reconcileApplication } from "./failure-context";
import {
  failedDeliveryId,
  envelopeFingerprint,
  failureIdSchema,
  recoveryMetadataSchema,
  type FailureRecord,
  type FailureSummary,
  type FailureResolution,
  type FailureProtocol,
  type WorkflowFailureStore,
} from "./failure-records";
import { captureWorkflowIdentity } from "./identity";
import { invalidStored } from "./stored";
import { freeze, instant, jsonCopy, plainObject, type WorkflowReadonly } from "./validation";

type InspectQuery = { id?: string; limit?: number; cursor?: string };
type Operation =
  | { action: "inspect"; query: InspectQuery }
  | { action: "replay"; id: string; failure: FailureSummary | null };
export type WorkflowOperationsAuthorizer = (
  auth: WorkflowReadonly<AuthContext>,
  operation: WorkflowReadonly<Operation>,
) => boolean | Promise<boolean>;
export type FailureHooks = Readonly<{
  reconcileFailure?: (
    input: Readonly<{ failure: WorkflowReadonly<FailureRecord>; generation: number }>,
  ) => FailureResolution | Promise<FailureResolution>;
  authorizeReplay?: (
    input: Readonly<{
      auth: WorkflowReadonly<AuthContext>;
      failure: WorkflowReadonly<FailureSummary>;
    }>,
  ) => boolean | Promise<boolean>;
}>;
type Change = { record: FailureRecord; replay?: JawStackEvent } | undefined;
const retryable = (e: unknown) =>
  e instanceof JawStackRuntimeError &&
  ["resource.conflict", "runtime.unavailable"].includes(e.code);
const forbidden = (): never => {
  throw new JawStackRuntimeError("auth.forbidden", "Workflow operations are not authorized.");
};
const unavailable = (): never => {
  throw new JawStackRuntimeError(
    "runtime.unavailable",
    "Failed-delivery update retry budget exhausted.",
  );
};

// Shared by complete runtimes and trusted backend adapter composition.
export function createWorkflowFailureService(options: {
  protocol: FailureProtocol;
  store: WorkflowFailureStore;
  clock?: () => Date;
  authorizeOperations?: WorkflowOperationsAuthorizer;
  hooks?: Readonly<Record<string, FailureHooks>>;
  eventId?: () => string;
  fault?: (point: "afterRecord" | "afterReconcile" | "afterReplayCommit") => void | Promise<void>;
}) {
  const { protocol, store, authorizeOperations, fault } = options;
  const clock = options.clock ?? (() => new Date()),
    eventId = options.eventId ?? randomUUID;
  if (
    typeof clock !== "function" ||
    typeof eventId !== "function" ||
    (authorizeOperations !== undefined && typeof authorizeOperations !== "function") ||
    (fault !== undefined && typeof fault !== "function") ||
    !plainObject(options.hooks ?? {})
  )
    throw new JawStackDefinitionError(
      "workflow.failures",
      "Invalid failure service configuration.",
    );
  const hooks = new Map<string, FailureHooks>();
  for (const name of Reflect.ownKeys(options.hooks ?? {})) {
    if (typeof name !== "string")
      throw new JawStackDefinitionError("workflow.failures", "Invalid consumer binding.");
    protocol.consumer(name);
    const binding = options.hooks![name]!;
    if (
      !plainObject(binding) ||
      Reflect.ownKeys(binding).some(
        (key) =>
          typeof key !== "string" ||
          !["reconcileFailure", "authorizeReplay"].includes(key) ||
          typeof binding[key as keyof FailureHooks] !== "function",
      )
    )
      throw new JawStackDefinitionError("workflow.failures", "Invalid failure hook binding.");
    hooks.set(name, Object.freeze({ ...binding }));
  }
  const now = () => instant(new Date(clock().getTime()).toISOString());
  const read = async (id: string) => {
    failureIdSchema.parse(id);
    try {
      const value = await store.get(id);
      if (value === undefined) return undefined;
      const row = protocol.parse(value);
      if (row.id !== id) invalidStored();
      return row;
    } catch (error) {
      if (error instanceof JawStackRuntimeError) throw error;
      throw new JawStackRuntimeError("runtime.unavailable", "Failed-delivery read failed.");
    }
  };
  const update = async (
    id: string,
    decide: (old: FailureRecord | undefined) => Change | Promise<Change>,
  ) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const old = await read(id),
        change = await decide(old);
      if (!change) {
        if (!old) invalidStored();
        return old;
      }
      const next = protocol.parse(change.record);
      try {
        await store.commit(old?.version ?? null, next, change.replay);
        return next;
      } catch (error) {
        if (error instanceof JawStackRuntimeError && !retryable(error)) throw error;
      }
    }
    // Converge even when the third successful commit lost its response; never write a fourth time.
    const final = await read(id);
    if (final && !(await decide(final))) return final;
    return unavailable();
  };
  const rootAuth = (identity: AuthContext) => {
    if (!authorizeOperations) return forbidden();
    try {
      return captureWorkflowIdentity(identity);
    } catch {
      return forbidden();
    }
  };
  const permit = async (auth: WorkflowReadonly<AuthContext>, action: Operation) => {
    try {
      if (
        (await validateReadOnly(() => authorizeOperations!(auth, freeze(jsonCopy(action))))) ===
        true
      )
        return;
    } catch {
      /* Unknown policy outcomes deny; never leak authorizer diagnostics. */
    }
    forbidden();
  };
  const authorize = async (consumer: string, input: unknown, allowForeignRecovery = false) => {
    const wire = protocol.wire(input);
    protocol.subscription(consumer, wire);
    const metadata = recoveryMetadataSchema.safeParse(wire.payload.delivery);
    if (!metadata.success || (!allowForeignRecovery && metadata.data.consumer !== consumer))
      throw new JawStackRuntimeError(
        "command.rejected",
        "A recorded targeted recovery is required.",
      );
    const row = await read(metadata.data.failureId),
      generation = metadata.data.generation;
    const recovery = row?.recoveries[generation - 1];
    if (
      !row ||
      row.consumer !== metadata.data.consumer ||
      protocol.consumer(row.consumer).recovery !== "replay" ||
      generation !== row.recoveries.length ||
      !recovery ||
      !equal(wire, protocol.replayEnvelope(row, recovery))
    )
      throw new JawStackRuntimeError(
        "command.rejected",
        "Replay does not match the current durable recovery request.",
      );
    return { record: row, generation, target: row.consumer === consumer };
  };
  const validateCollection = async (consumer: string, input: unknown) => {
    const wire = protocol.wire(input);
    protocol.subscription(consumer, wire);
    if ("delivery" in wire.payload) {
      await authorize(consumer, wire);
      return;
    }
    const previous = await read(failedDeliveryId(consumer, wire.eventId));
    if (previous && !equal(previous.original, wire))
      throw new JawStackRuntimeError("resource.conflict", "Failed event identity was reused.");
  };
  const collect = async (consumer: string, input: unknown): Promise<FailureSummary> => {
    assertFailureWritable();
    const wire = protocol.wire(input);
    protocol.subscription(consumer, wire);
    const authorized = "delivery" in wire.payload ? await authorize(consumer, wire) : undefined;
    const generation = authorized?.generation ?? 0,
      id = authorized?.record.id ?? failedDeliveryId(consumer, wire.eventId);
    const record = await update(id, (old) => {
      if (old) {
        if (!authorized && !equal(old.original, wire)) failureConflictIdentity();
        if (old.collections.some((c) => c.generation === generation)) return undefined;
        return {
          record: {
            ...old,
            version: old.version + 1,
            collections: [
              ...old.collections,
              {
                generation,
                eventId: wire.eventId,
                collectedAt: now(),
                reconciledAt: null,
                resolution: "pending",
              },
            ],
          },
        };
      }
      if (authorized) invalidStored();
      const at = now();
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
    await fault?.("afterRecord");
    if (record.collections.find((c) => c.generation === generation)!.resolution !== "pending")
      return protocol.summary(record);
    let resolution: FailureResolution = "notApplicable";
    const hook = hooks.get(consumer)?.reconcileFailure;
    if (hook) {
      try {
        resolution = await reconcileApplication(() =>
          hook({ failure: freeze(jsonCopy(record)), generation }),
        );
        if (!["notApplicable", "stalled", "failed", "superseded", "succeeded"].includes(resolution))
          throw new Error();
      } catch (error) {
        if (error instanceof JawStackRuntimeError) throw error;
        throw new JawStackRuntimeError(
          "runtime.unavailable",
          "Failure reconciliation did not complete.",
        );
      }
    }
    await fault?.("afterReconcile");
    const completed = await update(id, (old) => {
      if (!old) invalidStored();
      const stage = old.collections.find((c) => c.generation === generation);
      if (!stage) invalidStored();
      if (stage.resolution !== "pending") return undefined;
      return {
        record: {
          ...old,
          version: old.version + 1,
          collections: old.collections.map((c) =>
            c.generation === generation ? { ...c, resolution, reconciledAt: now() } : c,
          ),
          resolvedGeneration: ["succeeded", "superseded"].includes(resolution)
            ? Math.max(old.resolvedGeneration ?? 0, generation)
            : old.resolvedGeneration,
        },
      };
    });
    return protocol.summary(completed);
  };
  const complete = async (consumer: string, input: unknown) => {
    assertFailureWritable();
    const { record, generation } = await authorize(consumer, input);
    await update(record.id, (old) => {
      if (!old) invalidStored();
      if (old.resolvedGeneration !== null && old.resolvedGeneration >= generation) return undefined;
      return { record: { ...old, version: old.version + 1, resolvedGeneration: generation } };
    });
  };
  const inspect = async (
    identity: AuthContext,
    input: InspectQuery = {},
  ): Promise<FailureSummary | Page<FailureSummary>> => {
    const auth = rootAuth(identity);
    const parsed = z
      .strictObject({
        id: failureIdSchema.optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().min(1).max(4096).optional(),
      })
      .refine((v) => !v.id || (v.limit === undefined && v.cursor === undefined))
      .parse(jsonCopy(input));
    const query: InspectQuery = {
      ...(parsed.id === undefined ? {} : { id: parsed.id }),
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
    };
    await permit(auth, { action: "inspect", query });
    if (query.id) {
      const row = await read(query.id);
      if (!row)
        throw new JawStackRuntimeError("resource.not_found", "Failed delivery was not found.");
      return protocol.summary(row);
    }
    let page: Awaited<ReturnType<WorkflowFailureStore["query"]>>;
    try {
      page = await store.query(query);
    } catch (error) {
      if (error instanceof JawStackRuntimeError) throw error;
      throw new JawStackRuntimeError("runtime.unavailable", "Failed-delivery query failed.");
    }
    if (
      !Array.isArray(page.items) ||
      page.items.length > (query.limit ?? 50) ||
      (page.nextCursor !== undefined &&
        !z.string().min(1).max(4096).safeParse(page.nextCursor).success)
    )
      invalidStored();
    const items = page.items.map((row) => {
      const summary = protocol.parseSummary(row.data);
      if (
        row.projectionName !== protocol.projectionName ||
        row.itemId !== summary.id ||
        row.sort !== `${summary.firstCollectedAt}#${summary.id}`
      )
        invalidStored();
      return summary;
    });
    return { items, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
  };
  const replay = async (
    id: string,
    identity: AuthContext,
    requestId: string,
  ): Promise<FailureSummary> => {
    assertFailureWritable();
    const auth = rootAuth(identity);
    failureIdSchema.parse(id);
    z.uuid().parse(requestId);
    const first = await read(id);
    await permit(auth, { action: "replay", id, failure: first ? protocol.summary(first) : null });
    let candidate: FailureRecord["recoveries"][number] | undefined;
    const next = await update(id, async (old) => {
      if (!old)
        throw new JawStackRuntimeError("resource.not_found", "Failed delivery was not found.");
      if (protocol.consumer(old.consumer).recovery !== "replay")
        throw new JawStackRuntimeError("command.rejected", "Recovery is application-controlled.");
      if (old.recoveries.some((r) => r.requestId === requestId)) return undefined;
      if (old.resolvedGeneration === old.recoveries.length)
        throw new JawStackRuntimeError("command.rejected", "Delivery is already resolved.");
      const latest = old.collections.find((c) => c.generation === old.recoveries.length);
      if (!latest || (candidate && old.recoveries.length >= candidate.generation)) return undefined;
      if (latest.resolution === "pending")
        throw new JawStackRuntimeError(
          "resource.conflict",
          "Failure reconciliation is incomplete.",
        );
      if (old.recoveries.length >= 3)
        throw new JawStackRuntimeError("command.rejected", "Manual recovery budget exhausted.");
      const eligible = hooks.get(old.consumer)?.authorizeReplay;
      if (eligible) {
        try {
          if (
            (await validateReadOnly(() =>
              eligible({ auth, failure: freeze(protocol.summary(old)) }),
            )) !== true
          )
            forbidden();
        } catch {
          forbidden();
        }
      }
      candidate ??= {
        generation: old.recoveries.length + 1,
        eventId: z.uuid().parse(eventId()),
        requestedAt: now(),
        requestedBy: auth.subject,
        requestId,
      };
      const record = {
        ...old,
        version: old.version + 1,
        recoveries: [...old.recoveries, candidate],
      };
      return { record, replay: protocol.replayEnvelope(record, candidate) };
    });
    await fault?.("afterReplayCommit");
    return protocol.summary(next);
  };
  return Object.freeze({ authorize, validateCollection, collect, complete, inspect, replay });
}
function failureConflictIdentity(): never {
  throw new JawStackRuntimeError("resource.conflict", "Failed event identity was reused.");
}
