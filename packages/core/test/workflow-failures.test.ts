import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createWorkflowCommitPlanner,
  defineResource,
  defineCommand,
  defineState,
  field,
  JawStackRuntimeError,
  type AuthContext,
  type JawStackEvent,
} from "../src/index";
import { createWorkflowCommandDispatch } from "../src/workflow/command-runtime";
import { createMemoryWorkflowPersistence, memoryPhysicalKey } from "../src/workflow/memory";
import { workflowRecordKeys } from "../src/workflow/keys";
import {
  createFailureProtocol,
  failedDeliveryId,
  type WorkflowFailureStore,
  type FailureRecord,
  type FailureConsumer,
} from "../src/workflow/failure-records";
import { createMemoryWorkflowFailureStore } from "../src/workflow/failure-memory";
import {
  createWorkflowFailureService,
  type FailureHooks,
  type WorkflowOperationsAuthorizer,
} from "../src/workflow/failures";

const initial = "2026-11-01T12:00:00.000Z";
const operator = (): AuthContext => ({
  subject: "operator_1",
  roles: ["operator"],
  mode: "test",
  claims: { private: "operator-secret" },
});
const permit: WorkflowOperationsAuthorizer = (auth) =>
  auth.subject === "operator_1" && auth.roles.includes("operator");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const consumers: FailureConsumer[] = ["deliver", "observe", "publish"].map((name) => ({
  name,
  eventTypes: ["document.changed"],
  recovery: name === "publish" ? "application" : "replay",
}));
const event = (id = "original_1"): JawStackEvent<Record<string, unknown>> => ({
  envelopeVersion: 1,
  eventId: id,
  eventType: "document.changed",
  schemaVersion: 1,
  source: "documents",
  resourceType: "document",
  resourceId: "doc_1",
  actor: { subject: "author_1" },
  correlationId: "correlation_1",
  causationId: "request_1",
  occurredAt: initial,
  payload: { id: "doc_1", title: "Draft", token: "business-secret" },
});
function harness(
  options: {
    maxRecords?: number;
    hooks?: Readonly<Record<string, FailureHooks>>;
    authorizeOperations?: WorkflowOperationsAuthorizer;
    wrapStore?: (base: WorkflowFailureStore) => WorkflowFailureStore;
    eventId?: () => string;
    eventBytes?: number;
  } = {},
) {
  let time = Date.parse(initial);
  const clock = () => new Date(time);
  const protocol = createFailureProtocol({
    source: "documents",
    resourceType: "document",
    projectionName: "document.failures",
    consumers,
    ...(options.eventBytes === undefined ? {} : { eventBytes: options.eventBytes }),
    validateEvent: (fact) => {
      const payload = z
        .strictObject({ id: z.string(), title: z.string(), token: z.string() })
        .parse(fact.payload);
      if (
        fact.resourceType !== "document" ||
        fact.eventType !== "document.changed" ||
        fact.schemaVersion !== 1 ||
        fact.resourceId !== payload.id
      )
        throw new Error("Private domain validation");
    },
  });
  const planner = createWorkflowCommitPlanner({
    workflowName: "documents",
    source: "documents",
    idempotencyTtlSeconds: 604800,
  });
  const memory = createMemoryWorkflowPersistence({ planner });
  const baseStore = createMemoryWorkflowFailureStore({
    persistence: memory,
    protocol,
    ...(options.maxRecords === undefined ? {} : { maxRecords: options.maxRecords }),
  });
  const store = options.wrapStore?.(baseStore) ?? baseStore;
  const serviceOptions = {
    protocol,
    store,
    clock,
    authorizeOperations: options.authorizeOperations ?? permit,
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.eventId ? { eventId: options.eventId } : {}),
  };
  const makeService = (
    overrides: Partial<Parameters<typeof createWorkflowFailureService>[0]> = {},
  ) => createWorkflowFailureService({ ...serviceOptions, ...overrides });
  const service = makeService();
  const resource = defineResource({
    name: "document",
    title: "Document",
    state: defineState({ title: field.string() }),
    commands: {
      create: defineCommand({
        title: "Create",
        create: true,
        roles: ["operator"],
        input: z.strictObject({ title: z.string() }),
        emits: [{ eventType: "document.changed", schemaVersion: 1 }],
        decide: (context) => ({
          nextState: context.input,
          activity: [{ activityType: "created", title: "Created" }],
          response: { id: context.resourceId },
          events: [
            {
              eventType: "document.changed",
              schemaVersion: 1,
              payload: {
                id: context.resourceId,
                title: context.input.title,
                token: "business-secret",
              },
            },
          ],
        }),
      }),
    },
  });
  const dispatch = createWorkflowCommandDispatch({
    registry: [resource],
    source: "documents",
    persistence: memory.factory,
    clock,
  });
  const id = failedDeliveryId("deliver", "original_1");
  const row = async () => (await store.get(id))!;
  const replayWire = async (generation?: number) => {
    const record = await row();
    return protocol.replayEnvelope(
      record,
      record.recoveries[(generation ?? record.recoveries.length) - 1]!,
    );
  };
  const queue = async () => {
    await service.collect("deliver", event());
    return service.replay(id, operator(), randomUUID());
  };
  const snapshot = () =>
    structuredClone({
      failures: [...memory.failures],
      resources: [...memory.store.resources],
      projections: [...memory.store.projections],
      outbox: memory.store.outbox,
      activity: memory.store.activity,
      idempotency: [...memory.idempotency],
      records: [...memory.records],
    });
  return {
    memory,
    protocol,
    store,
    baseStore,
    service,
    makeService,
    dispatch,
    clock,
    id,
    row,
    replayWire,
    queue,
    snapshot,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("durable collection", () => {
  it("records one pending/settled history under concurrent duplicates and redacts inspection", async () => {
    const h = harness();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => h.service.collect("deliver", event())),
    );
    expect(results.every((r) => r.status === "failed")).toBe(true);
    expect(await h.row()).toMatchObject({
      version: 2,
      collections: [{ generation: 0, resolution: "notApplicable" }],
      recoveries: [],
    });
    expect(h.memory.failures.size).toBe(1);
    expect(h.memory.store.projections.size).toBe(1);
    const summary = await h.service.inspect(operator(), { id: h.id });
    expect(JSON.stringify(summary)).not.toMatch(
      /business-secret|operator-secret|original"|fingerprint|PK|SK|stack|token/,
    );
    expect(await h.service.collect("deliver", event())).toEqual(summary);
  });
  it("persists pending before the hook, keeps throwing work unacknowledged and resumes", async () => {
    let live = true;
    const h = harness({
      hooks: {
        deliver: {
          reconcileFailure: async ({ failure }) => {
            expect((await h.row()).collections[0]!.resolution).toBe("pending");
            expect(Object.isFrozen(failure.original.payload)).toBe(true);
            if (live) throw new JawStackRuntimeError("resource.conflict", "Claim still live.");
            return "stalled" as const;
          },
        },
      },
    });
    await expect(h.service.collect("deliver", event())).rejects.toMatchObject({
      code: "resource.conflict",
    });
    expect((await h.row()).collections[0]).toMatchObject({
      resolution: "pending",
      reconciledAt: null,
    });
    await expect(h.service.replay(h.id, operator(), randomUUID())).rejects.toMatchObject({
      code: "resource.conflict",
    });
    live = false;
    h.advance(1000);
    expect(await h.service.collect("deliver", event())).toMatchObject({
      resolution: "stalled",
      status: "failed",
    });
    expect((await h.row()).version).toBe(2);
  });
  it.each(["afterRecord", "afterReconcile"] as const)(
    "resumes interruption at %s without claiming a business transaction",
    async (point) => {
      let domainApplied = false,
        effects = 0;
      const h = harness({
        hooks: {
          deliver: {
            reconcileFailure: () => {
              if (!domainApplied) {
                domainApplied = true;
                effects++;
              }
              return "succeeded";
            },
          },
        },
      });
      let crash = true;
      const interrupted = h.makeService({
        fault: (at) => {
          if (at === point && crash) {
            crash = false;
            throw new Error("simulated stop");
          }
        },
      });
      await expect(interrupted.collect("deliver", event())).rejects.toThrow("simulated stop");
      expect((await h.row()).collections[0]!.resolution).toBe("pending");
      if (point === "afterReconcile") expect(domainApplied).toBe(true);
      expect(await h.service.collect("deliver", event())).toMatchObject({
        status: "resolved",
        resolution: "succeeded",
      });
      expect(effects).toBe(1);
    },
  );
  it("uses current domain authority when an interrupted reconciliation resumes", async () => {
    let completed = false;
    const h = harness({
      hooks: { deliver: { reconcileFailure: () => (completed ? "superseded" : "stalled") } },
    });
    const stopped = h.makeService({
      fault: (at) => {
        if (at === "afterReconcile") throw new Error("stopped");
      },
    });
    await expect(stopped.collect("deliver", event())).rejects.toThrow();
    completed = true;
    expect(await h.service.collect("deliver", event())).toMatchObject({
      status: "resolved",
      resolution: "superseded",
    });
  });
  it("does not reinterpret a throwing or invalid hook as notApplicable", async () => {
    for (const hook of [
      () => {
        throw new Error("private provider credential");
      },
      () => "pending",
      () => undefined,
    ]) {
      const h = harness({
        hooks: { deliver: { reconcileFailure: hook as FailureHooks["reconcileFailure"] & {} } },
      });
      await expect(h.service.collect("deliver", event())).rejects.toMatchObject({
        code: "runtime.unavailable",
        message: "Failure reconciliation did not complete.",
      });
      expect((await h.row()).collections[0]!.resolution).toBe("pending");
    }
  });
  it("allows authorized business commands but forbids ledger reentry from reconciliation", async () => {
    const h = harness({
      hooks: {
        deliver: {
          reconcileFailure: async () => {
            const old = await h.row();
            await expect(
              h.store.commit(old.version, { ...old, version: old.version + 1 }),
            ).rejects.toMatchObject({ code: "command.rejected" });
            await expect(h.service.collect("deliver", event())).rejects.toMatchObject({
              code: "command.rejected",
            });
            expect(
              await h.dispatch(
                {
                  resourceType: "document",
                  resourceId: "business",
                  commandName: "create",
                  input: { title: "Reconciled" },
                  idempotencyKey: "reconcile",
                  requestContext: {},
                },
                operator(),
              ),
            ).toMatchObject({ ok: true });
            return "stalled" as const;
          },
        },
      },
    });
    expect(await h.service.collect("deliver", event())).toMatchObject({ resolution: "stalled" });
    expect(h.memory.store.resources.size).toBe(1);
    expect(h.memory.store.outbox).toHaveLength(1);
  });
  it("retains read-only ledger restrictions in asynchronous reconciliation descendants", async () => {
    const resume = deferred();
    let descendant: Promise<void> | undefined;
    const h = harness({
      hooks: {
        deliver: {
          reconcileFailure: () => {
            descendant = (async () => {
              await resume.promise;
              await expect(h.service.collect("deliver", event("another"))).rejects.toMatchObject({
                code: "command.rejected",
              });
            })();
            return "notApplicable";
          },
        },
      },
    });
    await h.service.collect("deliver", event());
    resume.resolve();
    await descendant;
    expect(h.memory.failures.size).toBe(1);
  });
  it("keeps a concurrent durable completion when a late collector reports failure", async () => {
    const entered = deferred(),
      resume = deferred();
    const h = harness({
      hooks: {
        deliver: {
          reconcileFailure: async ({ generation }) => {
            if (generation === 1) {
              entered.resolve();
              await resume.promise;
            }
            return "failed" as const;
          },
        },
      },
    });
    await h.queue();
    const wire = await h.replayWire();
    const pending = h.service.collect("deliver", wire);
    await entered.promise;
    await h.service.complete("deliver", wire);
    resume.resolve();
    expect(await pending).toMatchObject({ status: "resolved", resolution: "failed" });
    const before = h.snapshot();
    await h.service.complete("deliver", wire);
    expect(h.snapshot()).toEqual(before);
    expect((await h.row()).resolvedGeneration).toBe(1);
  });
  it("snapshots incoming facts before an asynchronous store read", async () => {
    const entered = deferred(),
      resume = deferred();
    const h = harness({
      wrapStore: (base) => ({
        ...base,
        get: async (id) => {
          entered.resolve();
          await resume.promise;
          return base.get(id);
        },
      }),
    });
    const wire = event(),
      pending = h.service.collect("deliver", wire);
    await entered.promise;
    wire.payload.title = "changed";
    resume.resolve();
    await pending;
    expect((await h.row()).original.payload.title).toBe("Draft");
  });
  it("validates collection without writing and rejects reused original identity", async () => {
    const h = harness();
    await h.service.validateCollection("deliver", event());
    expect(h.memory.failures.size).toBe(0);
    await h.service.collect("deliver", event());
    const before = h.snapshot();
    const changed = { ...event(), payload: { ...event().payload, title: "Different" } };
    await expect(h.service.validateCollection("deliver", changed)).rejects.toMatchObject({
      code: "resource.conflict",
    });
    await expect(h.service.collect("deliver", changed)).rejects.toMatchObject({
      code: "resource.conflict",
    });
    expect(h.snapshot()).toEqual(before);
  });
  it.each(["source", "payload", "identity", "subscription", "tenant", "legacy", "forged"])(
    "does not persist invalid %s traffic",
    async (kind) => {
      const h = harness();
      const wire = event();
      let bad: unknown;
      if (kind === "source") bad = { ...wire, source: "foreign" };
      else if (kind === "payload") bad = { ...wire, payload: { arbitrary: true } };
      else if (kind === "identity") bad = { ...wire, resourceId: "other" };
      else if (kind === "subscription") bad = { ...wire, eventType: "document.other" };
      else if (kind === "tenant") bad = { ...wire, tenantId: "tenant" };
      else
        bad = {
          ...wire,
          payload: {
            ...wire.payload,
            delivery: {
              originalEventId: wire.eventId,
              generation: 1,
              ...(kind === "forged" ? { consumer: "deliver", failureId: h.id } : {}),
            },
          },
        };
      await expect(h.service.collect("deliver", bad)).rejects.toThrow();
      expect(h.memory.failures.size).toBe(0);
      expect(h.memory.store.projections.size).toBe(0);
      await expect(h.service.collect("unregistered", wire)).rejects.toMatchObject({
        code: "command.rejected",
      });
    },
  );
});

describe("authorized recorded replay", () => {
  it("treats an unexpected lost commit response as ambiguous and reads back its request", async () => {
    const ids = vi.fn(randomUUID);
    const h = harness({
      eventId: ids,
      wrapStore: (base) => ({
        ...base,
        commit: async (...args) => {
          await base.commit(...args);
          if (args[2]) throw new Error("private transport diagnostics");
        },
      }),
    });
    expect(await h.queue()).toMatchObject({ generation: 1, status: "replayQueued" });
    expect(ids).toHaveBeenCalledTimes(1);
    expect(h.memory.store.outbox).toHaveLength(1);
  });
  it("does not queue another generation if completion wins an eligibility/CAS race", async () => {
    const entered = deferred(),
      resume = deferred();
    let block = false;
    const h = harness({
      hooks: {
        deliver: {
          authorizeReplay: async () => {
            if (block) {
              entered.resolve();
              await resume.promise;
            }
            return true;
          },
        },
      },
    });
    await h.queue();
    const wire = await h.replayWire();
    await h.service.collect("deliver", wire);
    block = true;
    const replay = h.service.replay(h.id, operator(), randomUUID());
    const rejected = expect(replay).rejects.toMatchObject({ code: "command.rejected" });
    await entered.promise;
    await h.service.complete("deliver", wire);
    resume.resolve();
    await rejected;
    expect((await h.row()).recoveries).toHaveLength(1);
    expect((await h.row()).resolvedGeneration).toBe(1);
    expect(h.memory.store.outbox).toHaveLength(1);
  });
  it("denies unknown or throwing root policy outcomes and tenant auth", async () => {
    const h = harness();
    await h.service.collect("deliver", event());
    for (const authorizeOperations of [
      (() => undefined) as unknown as WorkflowOperationsAuthorizer,
      () => {
        throw new Error("private authorization diagnostic");
      },
    ]) {
      const service = h.makeService({ authorizeOperations });
      await expect(service.inspect(operator())).rejects.toMatchObject({ code: "auth.forbidden" });
      await expect(service.replay(h.id, operator(), randomUUID())).rejects.toMatchObject({
        code: "auth.forbidden",
      });
    }
    await expect(
      h.service.replay(h.id, { ...operator(), tenantId: "tenant" }, randomUUID()),
    ).rejects.toMatchObject({ code: "auth.forbidden" });
    await expect(h.service.replay(h.id, operator(), "not-a-uuid")).rejects.toThrow();
    expect(h.memory.store.outbox).toHaveLength(0);
  });
  it("denies absent authorizers before storage reads, including old request IDs", async () => {
    const h = harness();
    await h.queue();
    const get = vi.fn(h.store.get);
    const service = createWorkflowFailureService({
      protocol: h.protocol,
      store: { ...h.store, get },
      clock: h.clock,
    });
    await expect(service.inspect(operator())).rejects.toMatchObject({ code: "auth.forbidden" });
    await expect(
      service.replay(h.id, operator(), (await h.row()).recoveries[0]!.requestId),
    ).rejects.toMatchObject({ code: "auth.forbidden" });
    expect(get).not.toHaveBeenCalled();
  });
  it("requires resolved root authority and applies optional eligibility only as another restriction", async () => {
    const h = harness({ hooks: { deliver: { authorizeReplay: () => false } } });
    await h.service.collect("deliver", event());
    await expect(
      h.service.replay(h.id, { ...operator(), subject: "impostor" }, randomUUID()),
    ).rejects.toMatchObject({ code: "auth.forbidden" });
    await expect(h.service.replay(h.id, operator(), randomUUID())).rejects.toMatchObject({
      code: "auth.forbidden",
    });
    const failing = h.makeService({
      hooks: {
        deliver: {
          authorizeReplay: () => {
            throw new Error("private eligibility error");
          },
        },
      },
    });
    await expect(failing.replay(h.id, operator(), randomUUID())).rejects.toMatchObject({
      code: "auth.forbidden",
    });
    expect(h.memory.store.outbox).toHaveLength(0);
  });
  it("snapshots authorization and prevents writes from policy hooks", async () => {
    const entered = deferred(),
      resume = deferred();
    const h = harness({
      authorizeOperations: async (identity, operation) => {
        expect(Object.isFrozen(identity.claims)).toBe(true);
        expect(Object.isFrozen(operation)).toBe(true);
        entered.resolve();
        await resume.promise;
        expect(
          await h.dispatch(
            {
              resourceType: "document",
              resourceId: "forbidden",
              commandName: "create",
              input: { title: "No" },
              idempotencyKey: "policy",
              requestContext: {},
            },
            operator(),
          ),
        ).toMatchObject({ ok: false, error: { code: "command.rejected" } });
        return permit(identity, operation);
      },
    });
    await h.service.collect("deliver", event());
    const identity = operator(),
      pending = h.service.replay(h.id, identity, randomUUID());
    await entered.promise;
    (identity as { subject: string }).subject = "changed";
    resume.resolve();
    expect(await pending).toMatchObject({ recoveries: [{ requestedBy: "operator_1" }] });
    expect(h.memory.store.resources.size).toBe(0);
  });
  it("keeps application-only policy inspectable but forbids generic replay", async () => {
    const h = harness();
    const result = await h.service.collect("publish", event());
    expect(await h.service.inspect(operator(), { id: result.id })).toEqual(result);
    await expect(h.service.replay(result.id, operator(), randomUUID())).rejects.toMatchObject({
      code: "command.rejected",
    });
    expect(h.memory.store.outbox).toHaveLength(0);
  });
  it("atomically converges concurrent operator requests without consuming extra cycles", async () => {
    const h = harness();
    await h.service.collect("deliver", event());
    const results = await Promise.all(
      Array.from({ length: 8 }, () => h.service.replay(h.id, operator(), randomUUID())),
    );
    for (const result of results) expect(result).toEqual(results[0]);
    expect((await h.row()).recoveries).toHaveLength(1);
    expect(h.memory.store.outbox).toHaveLength(1);
    const wire = await h.replayWire();
    expect(z.uuid().safeParse(wire.eventId).success).toBe(true);
    expect(wire).toMatchObject({
      actor: event().actor,
      correlationId: event().correlationId,
      causationId: event().eventId,
      payload: {
        token: "business-secret",
        delivery: { generation: 1, consumer: "deliver", failureId: h.id },
      },
    });
  });
  it("returns recorded history for the same UUID even after completion, but rechecks root authority", async () => {
    const h = harness();
    await h.service.collect("deliver", event());
    const request = randomUUID();
    await h.service.replay(h.id, operator(), request);
    await h.service.complete("deliver", await h.replayWire());
    const before = h.snapshot();
    expect(await h.service.replay(h.id, operator(), request)).toMatchObject({
      status: "resolved",
      generation: 1,
    });
    await expect(
      h.service.replay(h.id, { ...operator(), roles: [] }, request),
    ).rejects.toMatchObject({ code: "auth.forbidden" });
    expect(h.snapshot()).toEqual(before);
  });
  it("uses one UUID/time when unavailable commits require three CAS attempts", async () => {
    let writes = 0;
    const ids = vi.fn(randomUUID);
    const h = harness({
      eventId: ids,
      wrapStore: (base) => ({
        ...base,
        commit: async (version, record, replay) => {
          if (replay && ++writes < 3)
            throw new JawStackRuntimeError("runtime.unavailable", "Retry.");
          await base.commit(version, record, replay);
          if (replay) throw new JawStackRuntimeError("runtime.unavailable", "Final response lost.");
        },
      }),
    });
    await h.queue();
    expect(writes).toBe(3);
    expect(ids).toHaveBeenCalledTimes(1);
    expect((await h.row()).recoveries).toHaveLength(1);
    expect(h.memory.store.outbox).toHaveLength(1);
  });
  it("recovers a crash after durable replay with the operator request UUID", async () => {
    const h = harness();
    await h.service.collect("deliver", event());
    const request = randomUUID();
    const interrupted = h.makeService({
      fault: (point) => {
        if (point === "afterReplayCommit") throw new Error("CLI stopped");
      },
    });
    await expect(interrupted.replay(h.id, operator(), request)).rejects.toThrow("CLI stopped");
    const before = h.snapshot();
    expect(await h.service.replay(h.id, operator(), request)).toMatchObject({
      generation: 1,
      status: "replayQueued",
    });
    expect(h.snapshot()).toEqual(before);
  });
  it("bounds retries and reports unavailable without inventing durable success", async () => {
    const commits = vi.fn();
    const h = harness({
      wrapStore: (base) => ({
        ...base,
        commit: async (...args) => {
          if (args[2]) {
            commits();
            throw new JawStackRuntimeError("runtime.unavailable", "Unavailable");
          }
          return base.commit(...args);
        },
      }),
    });
    await h.service.collect("deliver", event());
    const before = h.snapshot();
    await expect(h.service.replay(h.id, operator(), randomUUID())).rejects.toMatchObject({
      code: "runtime.unavailable",
    });
    expect(commits).toHaveBeenCalledTimes(3);
    expect(h.snapshot()).toEqual(before);
  });
  it("enforces three cycles independently of elapsed time or marker expiry", async () => {
    const h = harness();
    await h.service.collect("deliver", event());
    for (let generation = 1; generation <= 3; generation++) {
      await h.service.replay(h.id, operator(), randomUUID());
      await h.service.collect("deliver", await h.replayWire());
    }
    h.advance(30 * 86_400_000);
    await expect(h.service.replay(h.id, operator(), randomUUID())).rejects.toMatchObject({
      code: "command.rejected",
    });
    expect((await h.row()).collections).toHaveLength(4);
    expect((await h.row()).recoveries).toHaveLength(3);
    expect(await h.row()).not.toHaveProperty("expiresAt");
  });
  it.each([
    "eventId",
    "payload",
    "actor",
    "source",
    "causation",
    "time",
    "failureId",
    "consumer",
    "generation",
  ])("rejects forged replay %s before completion or collection", async (kind) => {
    const h = harness();
    await h.queue();
    const wire = await h.replayWire();
    let bad: unknown;
    if (kind === "eventId") bad = { ...wire, eventId: randomUUID() };
    else if (kind === "payload") bad = { ...wire, payload: { ...wire.payload, token: "forged" } };
    else if (kind === "actor") bad = { ...wire, actor: { subject: "other" } };
    else if (kind === "source") bad = { ...wire, source: "foreign" };
    else if (kind === "causation") bad = { ...wire, causationId: "other" };
    else if (kind === "time") bad = { ...wire, occurredAt: "2026-11-01T12:01:00.000Z" };
    else
      bad = {
        ...wire,
        payload: {
          ...wire.payload,
          delivery: {
            ...(wire.payload.delivery as object),
            [kind]: kind === "failureId" ? "0".repeat(64) : kind === "consumer" ? "observe" : 2,
          },
        },
      };
    const before = h.snapshot();
    await expect(h.service.authorize("deliver", bad)).rejects.toThrow();
    await expect(h.service.complete("deliver", bad)).rejects.toThrow();
    await expect(h.service.collect("deliver", bad)).rejects.toThrow();
    expect(h.snapshot()).toEqual(before);
  });
  it("rejects superseded recovery generations and authenticates non-target fanout", async () => {
    const h = harness();
    await h.queue();
    const first = await h.replayWire();
    await expect(h.service.authorize("observe", first)).rejects.toThrow();
    expect(await h.service.authorize("observe", first, true)).toMatchObject({
      target: false,
      generation: 1,
    });
    await expect(h.service.complete("observe", first)).rejects.toThrow();
    await h.service.collect("deliver", first);
    await h.service.replay(h.id, operator(), randomUUID());
    await expect(h.service.authorize("deliver", first)).rejects.toMatchObject({
      code: "command.rejected",
    });
    await expect(h.service.authorize("observe", first, true)).rejects.toMatchObject({
      code: "command.rejected",
    });
    expect(await h.service.authorize("deliver", await h.replayWire())).toMatchObject({
      target: true,
      generation: 2,
    });
  });
});

describe("failure storage, queries and compatibility", () => {
  it("preserves all categories on an immutable outbox collision and then releases the lock", async () => {
    const h = harness();
    await h.service.collect("deliver", event());
    const old = await h.row();
    const recovery = {
      generation: 1,
      eventId: randomUUID(),
      requestedAt: initial,
      requestedBy: "operator_1",
      requestId: randomUUID(),
    };
    const next = { ...old, version: old.version + 1, recoveries: [recovery] },
      wire = h.protocol.replayEnvelope(next, recovery);
    h.memory.store.outbox.push(structuredClone(wire));
    const before = h.snapshot();
    await expect(h.store.commit(old.version, next, wire)).rejects.toMatchObject({
      code: "resource.conflict",
    });
    expect(h.snapshot()).toEqual(before);
    h.memory.store.outbox.length = 0;
    await h.store.commit(old.version, next, wire);
    expect((await h.row()).recoveries).toHaveLength(1);
  });
  it("rolls back a failure projection collision or corrupt existing projection", async () => {
    const h = harness();
    const key = memoryPhysicalKey(
      workflowRecordKeys.projection("document", {
        projectionName: "document.failures",
        itemId: h.id,
        sort: initial,
      }),
    );
    h.memory.store.projections.set(key, {
      projectionName: "document.failures",
      itemId: h.id,
      sort: `${initial}#${h.id}`,
      data: {},
    });
    const before = h.snapshot();
    await expect(h.service.collect("deliver", event())).rejects.toMatchObject({
      code: "runtime.unavailable",
    });
    expect(h.snapshot()).toEqual(before);
    h.memory.store.projections.delete(key);
    await h.service.collect("deliver", event());
    h.memory.store.projections.set(key, {
      ...h.memory.store.projections.get(key)!,
      data: { invalid: true },
    });
    const corrupt = h.snapshot();
    await expect(h.service.replay(h.id, operator(), randomUUID())).rejects.toMatchObject({
      code: "resource.invalid_state",
    });
    expect(h.snapshot()).toEqual(corrupt);
  });
  it("does not partially publish into a frozen backing container", async () => {
    const h = harness();
    await h.service.collect("deliver", event());
    Object.freeze(h.memory.store.outbox);
    const before = h.snapshot();
    await expect(h.service.replay(h.id, operator(), randomUUID())).rejects.toMatchObject({
      code: "resource.invalid_state",
    });
    expect(h.snapshot()).toEqual(before);
  });
  it("shares the command lock and preserves domain projections while failure work is staged", async () => {
    const h = harness();
    const pending = h.service.collect("deliver", event());
    const command = h.dispatch(
      {
        resourceType: "document",
        resourceId: "new_doc",
        commandName: "create",
        input: { title: "New" },
        idempotencyKey: "new",
        requestContext: {},
      },
      operator(),
    );
    const projection = {
      projectionName: "document.notifications",
      itemId: "notice",
      sort: "now#notice",
      data: { delivered: true },
    };
    const key = memoryPhysicalKey(workflowRecordKeys.projection("document", projection));
    h.memory.store.projections.set(key, projection);
    expect(await command).toMatchObject({ ok: true });
    await pending;
    expect(h.memory.store.projections.get(key)).toEqual(projection);
    expect(h.memory.store.resources.size).toBe(1);
    expect(h.memory.failures.size).toBe(1);
  });
  it("bounds retention without eviction and allows duplicates/replay at capacity", async () => {
    const h = harness({ maxRecords: 1 });
    await h.service.collect("deliver", event());
    const before = h.snapshot();
    await expect(h.service.collect("deliver", event("second"))).rejects.toMatchObject({
      code: "runtime.unavailable",
    });
    expect(h.snapshot()).toEqual(before);
    await h.service.collect("deliver", event());
    await h.service.replay(h.id, operator(), randomUUID());
    expect(h.memory.failures.size).toBe(1);
  });
  it.each([0, -1, 10_001, 1.5, NaN])("rejects invalid retention capacity %s", (maxRecords) => {
    expect(() => harness({ maxRecords })).toThrow(/capacity|Invalid/);
  });
  it("rejects a second ledger mounted on the same workflow persistence", () => {
    const h = harness();
    expect(() =>
      createMemoryWorkflowFailureStore({ protocol: h.protocol, persistence: h.memory }),
    ).toThrow(/mounted/);
    expect(() =>
      createMemoryWorkflowFailureStore({ protocol: h.protocol, persistence: { ...h.memory } }),
    ).toThrow(/mounted/);
  });
  it("rejects a stored recovery requested before collection settled", async () => {
    const h = harness();
    await h.queue();
    const record = await h.row();
    record.collections[0] = {
      ...record.collections[0]!,
      resolution: "pending",
      reconciledAt: null,
    };
    expect(() => h.protocol.parse(record)).toThrow(/Stored workflow/);
  });
  it("redacts unexpected query errors and rejects oversized adapter pages", async () => {
    const h = harness();
    const service = h.makeService({
      store: {
        ...h.store,
        query: async () => {
          throw new Error("private AWS endpoint and credentials");
        },
      },
    });
    await expect(service.inspect(operator())).rejects.toMatchObject({
      code: "runtime.unavailable",
      message: "Failed-delivery query failed.",
    });
    await h.service.collect("deliver", event());
    const projection = h.protocol.projection(await h.row());
    const overflow = h.makeService({
      store: { ...h.store, query: async () => ({ items: [projection, projection] }) },
    });
    await expect(overflow.inspect(operator(), { limit: 1 })).rejects.toMatchObject({
      code: "resource.invalid_state",
    });
  });
  it("rejects invalid consumer policies and asynchronous domain validators", () => {
    const config = {
      source: "documents",
      resourceType: "document",
      projectionName: "document.failures",
      consumers,
      validateEvent: () => {},
    };
    expect(() =>
      createFailureProtocol({
        ...config,
        consumers: [{ ...consumers[0]!, recovery: "unknown" as "replay" }],
      }),
    ).toThrow(/configuration/);
    const protocol = createFailureProtocol({
      ...config,
      validateEvent: async () => {
        throw new Error("observed rejection");
      },
    });
    expect(() => protocol.wire(event())).toThrow(/Invalid workflow fact/);
  });
  it.each([
    "original",
    "fingerprint",
    "firstCollectedAt",
    "consumer",
    "version",
    "collections",
    "recoveries",
    "resolvedGeneration",
  ])("rejects history regression or rewrite: %s", async (field) => {
    const h = harness();
    await h.queue();
    await h.service.collect("deliver", await h.replayWire());
    await h.service.complete("deliver", await h.replayWire());
    const old = await h.row(),
      next = structuredClone({ ...old, version: old.version + 1 });
    if (field === "original") next.original.payload.token = "changed";
    else if (field === "fingerprint") next.fingerprint = "0".repeat(64);
    else if (field === "firstCollectedAt") next.firstCollectedAt = "2026-10-31T12:00:00.000Z";
    else if (field === "consumer") next.consumer = "observe";
    else if (field === "version") next.version++;
    else if (field === "collections") next.collections[0]!.resolution = "failed";
    else if (field === "recoveries") next.recoveries.length = 0;
    else next.resolvedGeneration = null;
    const before = h.snapshot();
    await expect(h.store.commit(old.version, next)).rejects.toThrow();
    expect(h.snapshot()).toEqual(before);
  });
  it("rejects stale CAS and detached or corrupt stored data", async () => {
    const h = harness();
    await h.service.collect("deliver", event());
    const row = await h.row();
    row.original.payload.title = "mutated copy";
    expect((await h.row()).original.payload.title).toBe("Draft");
    const old = await h.row();
    await expect(h.store.commit(0, { ...old, version: old.version + 1 })).rejects.toMatchObject({
      code: "resource.conflict",
    });
    const key = memoryPhysicalKey(h.protocol.key(h.id));
    h.memory.failures.set(key, undefined);
    await expect(h.service.inspect(operator(), { id: h.id })).rejects.toMatchObject({
      code: "resource.invalid_state",
    });
  });
  it("bounds fact payload bytes and encoded failure rows before any write", async () => {
    const h = harness();
    const wire = event();
    const limit = 80 * 1024;
    const fixed = Buffer.byteLength(JSON.stringify({ ...wire.payload, token: "" }));
    wire.payload.token = "x".repeat(limit - fixed);
    await h.service.collect("deliver", wire);
    expect(h.memory.failures.size).toBe(1);
    const oversized = {
      ...wire,
      eventId: "oversized",
      payload: { ...wire.payload, token: `${wire.payload.token}x` },
    };
    const before = h.snapshot();
    await expect(h.service.collect("deliver", oversized)).rejects.toMatchObject({
      code: "command.validation",
    });
    expect(h.snapshot()).toEqual(before);
    const corrupt = {
      ...(await h.row()),
      original: { ...wire, payload: { ...wire.payload, token: "x".repeat(128 * 1024) } },
    };
    expect(() => h.protocol.parse(corrupt)).toThrow(/Stored workflow/);
  });
  it("pages redacted summaries with the existing opaque keyset cursor contract", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await h.service.collect("deliver", event(`original_${i}`));
    const first = await h.service.inspect(operator(), { limit: 2 });
    if (!("items" in first)) throw new Error();
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const second = await h.service.inspect(operator(), { limit: 2, cursor: first.nextCursor! });
    if (!("items" in second)) throw new Error();
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.items, ...second.items].map((r) => r.id)).size).toBe(3);
    expect(JSON.stringify([first, second])).not.toMatch(
      /business-secret|operator-secret|fingerprint|payload|PK|SK/,
    );
    await expect(h.service.inspect(operator(), { limit: 101 })).rejects.toThrow();
    await expect(h.service.inspect(operator(), { cursor: "forged" })).rejects.toThrow();
  });
  it("rejects a projection that would leak private stored payloads or unknown consumers", async () => {
    const h = harness();
    await h.service.collect("deliver", event());
    const [key, projection] = [...h.memory.store.projections][0]!;
    h.memory.store.projections.set(key, {
      ...projection,
      data: { ...(projection.data as object), original: event() },
    });
    await expect(h.service.inspect(operator())).rejects.toMatchObject({
      code: "resource.invalid_state",
    });
    h.memory.store.projections.set(key, {
      ...projection,
      data: { ...h.protocol.summary(await h.row()), consumer: "removed" },
    });
    await expect(h.service.inspect(operator())).rejects.toMatchObject({
      code: "resource.invalid_state",
    });
  });
  it("reads frozen legacy rows and writes the same summary, projection, failure key and replay bytes", async () => {
    const golden = JSON.parse(
      readFileSync(
        new URL(
          "../../../docs/iterations/003-framework-leverage/leverage/compatibility.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const record = golden.failure.record as FailureRecord;
    const protocol = createFailureProtocol({
      source: record.original.source,
      resourceType: record.original.resourceType,
      projectionName: `${record.original.resourceType}.failures`,
      consumers: [
        { name: record.consumer, recovery: "replay", eventTypes: [record.original.eventType] },
      ],
      validateEvent: (fact) => {
        if (fact.resourceId !== fact.payload.contentId) throw new Error();
      },
    });
    expect(protocol.parse(record)).toEqual(record);
    expect(protocol.summary(record)).toEqual(golden.failure.summary);
    expect(JSON.stringify(protocol.replayEnvelope(record, record.recoveries[0]!))).toBe(
      golden.replayJson,
    );
    expect(protocol.key(record.id)).toEqual({
      partition: golden.failure.key.PK,
      sort: golden.failure.key.SK,
    });
    const memory = createMemoryWorkflowPersistence({
      planner: createWorkflowCommitPlanner({
        workflowName: "fixture",
        source: record.original.source,
        idempotencyTtlSeconds: 604800,
      }),
    });
    const store = createMemoryWorkflowFailureStore({ persistence: memory, protocol });
    const pending = {
      ...structuredClone(record),
      version: 1,
      recoveries: [],
      collections: record.collections.map((c) => ({
        ...c,
        resolution: "pending" as const,
        reconciledAt: null,
      })),
    };
    await store.commit(null, pending);
    await store.commit(1, { ...record, version: 2, recoveries: [] });
    const replay = protocol.replayEnvelope(record, record.recoveries[0]!);
    await store.commit(2, record, replay);
    expect(await store.get(record.id)).toEqual(record);
    expect(JSON.stringify(memory.store.outbox[0])).toBe(golden.replayJson);
    const key = JSON.stringify({
      PK: golden.failure.projectionItem.PK.S,
      SK: golden.failure.projectionItem.SK.S,
    });
    expect(memory.store.projections.get(key)).toEqual(protocol.projection(record));
  });
});
