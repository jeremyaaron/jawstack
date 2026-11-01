import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createWorkflowCommitPlanner,
  defineAtomicRecord,
  defineCommand,
  defineResource,
  defineState,
  field,
  InMemoryRepository,
  InMemoryStore,
  JawStackRuntimeError,
  type AuthContext,
  type CommandContext,
  type CommandRequest,
  type ResourceState,
  type WorkflowCommitContributor,
  type WorkflowCommitPlan,
  type WorkflowCommandScope,
} from "../src/index";
import {
  createWorkflowCommandDispatch,
  type WorkflowPersistenceFactory,
  type WorkflowResultValidator,
} from "../src/workflow/command-runtime";
import { createMemoryWorkflowPersistence, memoryPhysicalKey } from "../src/workflow/memory";
import { workflowRecordKeys } from "../src/workflow/keys";

const initial = "2026-11-01T12:00:00.000Z";
const auth = (subject = "user_1"): AuthContext => ({
  subject,
  roles: ["user"],
  mode: "test",
  claims: {},
});
const receipt = defineAtomicRecord({
  name: "receipt",
  schema: z.strictObject({
    resourceType: z.string(),
    resourceId: z.string(),
    version: z.number(),
    subject: z.string(),
  }),
  key: (v) => `${v.resourceType}#${v.resourceId}#${v.version}`,
  owner: (v) => ({ resourceType: v.resourceType, resourceId: v.resourceId }),
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(
  options: {
    persistence?: (factory: WorkflowPersistenceFactory) => WorkflowPersistenceFactory;
    contribute?: WorkflowCommitContributor;
    validateResult?: WorkflowResultValidator;
    ids?: Parameters<typeof createWorkflowCommandDispatch>[0]["ids"];
    decide?: (
      context: CommandContext<unknown, { title: string; expectedVersion?: number | undefined }>,
    ) => void | Promise<void>;
  } = {},
) {
  let time = Date.parse(initial),
    sequence = 0,
    decisions = 0;
  const clock = vi.fn(() => new Date(time));
  const resources = ["document", "note"].map((name) =>
    defineResource({
      name,
      title: name,
      state: defineState({ title: field.string() }),
      commands: Object.fromEntries(
        ["create", "edit"].map((commandName) => [
          commandName,
          defineCommand({
            title: commandName,
            create: commandName === "create",
            roles: ["user"],
            input: z.strictObject({
              title: z.string().trim(),
              expectedVersion: z.number().int().positive().optional(),
            }),
            emits: [{ eventType: `${name}.changed`, schemaVersion: 1 }],
            decide: async (context) => {
              decisions++;
              await options.decide?.(context);
              if (context.previous && context.input.expectedVersion !== context.previous.version)
                throw new JawStackRuntimeError("resource.conflict", "Stale version.");
              const version = (context.previous?.version ?? 0) + 1;
              const row = {
                projectionName: `${name}.list`,
                itemId: context.resourceId,
                sort: `v${version}`,
                data: { title: context.input.title },
              };
              return {
                nextState: { title: context.input.title },
                activity: [{ activityType: "changed", title: "Changed" }],
                events: [
                  {
                    eventType: `${name}.changed`,
                    schemaVersion: 1,
                    payload: { title: context.input.title },
                  },
                ],
                projections: [
                  ...(context.previous ? [{ ...row, sort: `v${version - 1}`, delete: true }] : []),
                  row,
                ],
                response: { id: context.resourceId, title: context.input.title },
              };
            },
          }),
        ]),
      ),
    }),
  );
  const basePlanner = createWorkflowCommitPlanner({
    workflowName: "documents",
    source: "documents",
    idempotencyTtlSeconds: 604800,
    records: [receipt],
    contribute:
      options.contribute ??
      (({ invocation, commit }) => ({
        records: [
          receipt.create({
            resourceType: commit.resource.resourceType,
            resourceId: commit.resource.resourceId,
            version: commit.resource.next.version,
            subject: invocation.scope.subject,
          }),
        ],
      })),
  });
  const plans: WorkflowCommitPlan[] = [];
  const planner = {
    ...basePlanner,
    plan: (...args: Parameters<typeof basePlanner.plan>) => {
      const plan = basePlanner.plan(...args);
      plans.push(plan);
      return plan;
    },
  };
  const memory = createMemoryWorkflowPersistence({ planner });
  const dispatch = createWorkflowCommandDispatch({
    registry: resources,
    persistence: options.persistence?.(memory.factory) ?? memory.factory,
    source: "documents",
    clock,
    ...(options.validateResult ? { validateResult: options.validateResult } : {}),
    ids: {
      requestId: () => `request_${++sequence}`,
      correlationId: () => `correlation_${++sequence}`,
      eventId: () => `event_${++sequence}`,
      activityId: () => `activity_${++sequence}`,
      ...options.ids,
    },
  });
  const request = (
    key = "key",
    title = "Draft",
    id = "doc_1",
    commandName = "create",
    resourceType = "document",
  ): CommandRequest => ({
    resourceType,
    resourceId: id,
    commandName,
    input: { title, ...(commandName === "edit" ? { expectedVersion: 1 } : {}) },
    idempotencyKey: key,
    requestContext: {
      ignored: () => {
        throw new Error("Do not inspect context.");
      },
    },
  });
  const snapshot = () =>
    structuredClone({
      resources: [...memory.store.resources],
      activity: memory.store.activity,
      outbox: memory.store.outbox,
      projections: [...memory.store.projections],
      idempotency: [...memory.idempotency],
      records: [...memory.records],
      legacyIdempotency: [...memory.store.idempotency],
    });
  return {
    memory,
    planner,
    plans,
    dispatch,
    request,
    snapshot,
    clock,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    decisions: () => decisions,
    run: (key = "key", title = "Draft", id = "doc_1", identity = auth()) =>
      dispatch(request(key, title, id), identity),
  };
}

describe("scoped command execution", () => {
  it("commits all categories once and converges concurrent equivalent retries with original metadata", async () => {
    const h = harness();
    const results = await Promise.all(Array.from({ length: 12 }, () => h.run()));
    expect(results[0]).toMatchObject({ ok: true });
    for (const result of results) expect(result).toEqual(results[0]);
    expect(h.memory.store.resources.size).toBe(1);
    expect(h.memory.store.activity).toHaveLength(1);
    expect(h.memory.store.outbox).toHaveLength(1);
    expect(h.memory.store.projections.size).toBe(1);
    expect(h.memory.idempotency.size).toBe(1);
    expect(h.memory.records.size).toBe(1);
    expect(h.memory.store.idempotency.size).toBe(0);
    const before = h.snapshot();
    expect(await h.run("key", "  Draft  ")).toEqual(results[0]);
    expect(await h.run("key", "other")).toMatchObject({
      ok: false,
      error: { code: "idempotency.conflict" },
    });
    expect(await h.run("key", "Draft", "doc_2")).toMatchObject({
      ok: false,
      error: { code: "idempotency.conflict" },
    });
    expect(h.snapshot()).toEqual(before);
  });
  it("isolates subjects, resource types and commands sharing a key", async () => {
    const h = harness();
    const results = await Promise.all([
      h.run(),
      h.run("key", "Two", "doc_2", auth("user_2")),
      h.dispatch(h.request("key", "Note", "doc_1", "create", "note"), auth()),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await h.dispatch(h.request("key", "Edited", "doc_1", "edit"), auth())).toMatchObject({
      ok: true,
    });
    expect(h.memory.idempotency.size).toBe(4);
    expect(h.memory.store.resources.size).toBe(3);
    expect(await h.run()).toEqual(results[0]);
  });
  it("captures auth, input, target and time before yielding and never inspects ingress context", async () => {
    const entered = deferred(),
      resume = deferred();
    let seen: Parameters<WorkflowResultValidator>[0] | undefined;
    const h = harness({
      persistence: (factory) => (scope, now) => {
        const base = factory(scope, now);
        return {
          ...base,
          repository: {
            ...base.repository,
            getIdempotency: async (key) => {
              entered.resolve();
              await resume.promise;
              return base.repository.getIdempotency(key);
            },
          },
        };
      },
      validateResult: (input) => {
        seen = input;
      },
    });
    const identity = { ...auth(), roles: ["user"], claims: { private: "secret" } };
    const request = h.request();
    Object.defineProperty(request, "requestContext", {
      get: () => {
        throw new Error("Opaque context read");
      },
    });
    const pending = h.dispatch(request, identity);
    await entered.promise;
    identity.subject = "other";
    identity.roles.length = 0;
    identity.claims.private = "changed";
    (request.input as { title: string }).title = "changed";
    (request as { resourceId: string }).resourceId = "other";
    h.advance(86_400_000);
    resume.resolve();
    expect(await pending).toMatchObject({ ok: true, data: { id: "doc_1", title: "Draft" } });
    expect([...h.memory.store.resources.values()][0]).toMatchObject({
      updatedBy: "user_1",
      updatedAt: initial,
    });
    expect(seen?.request).not.toHaveProperty("requestContext");
    expect(seen).not.toHaveProperty("auth");
    expect(JSON.stringify(h.snapshot())).not.toMatch(/secret|private/);
  });
  it.each([undefined, "", " ", "x".repeat(201), "key#unsafe", "key\n", "\u00e9"])(
    "rejects invalid mandatory key before persistence: %s",
    async (key) => {
      const factoryCalled = vi.fn();
      const h = harness({
        persistence:
          (factory) =>
          (...args) => {
            factoryCalled();
            return factory(...args);
          },
      });
      const request = { ...h.request(), idempotencyKey: key } as CommandRequest;
      expect(await h.dispatch(request, auth())).toMatchObject({
        ok: false,
        error: { code: "command.rejected" },
      });
      expect(factoryCalled).not.toHaveBeenCalled();
      expect(h.memory.store.resources.size).toBe(0);
    },
  );
  it("rejects tenant auth and preserves server authorization on cached retries", async () => {
    const h = harness();
    expect(await h.dispatch(h.request(), { ...auth(), tenantId: "tenant_1" })).toMatchObject({
      ok: false,
      error: { code: "auth.forbidden" },
    });
    expect(await h.run()).toMatchObject({ ok: true });
    const before = h.snapshot();
    expect(await h.dispatch(h.request(), { ...auth(), roles: [] })).toMatchObject({
      ok: false,
      error: { code: "auth.forbidden" },
    });
    expect(h.snapshot()).toEqual(before);
  });
  it("logically expires and conditionally replaces a still-present seven-day row", async () => {
    const h = harness();
    const first = await h.run();
    h.advance(604_800_000 - 1);
    expect(await h.run()).toEqual(first);
    h.advance(1);
    const second = await h.run("key", "New", "doc_2");
    expect(second).toMatchObject({ ok: true });
    expect(second).not.toEqual(first);
    expect(h.memory.store.resources.size).toBe(2);
    expect(h.memory.idempotency.size).toBe(1);
    expect([...h.memory.idempotency.values()][0]!.createdAt).toBe("2026-11-08T12:00:00.000Z");
    expect(await h.run("key", "New", "doc_2")).toEqual(second);
  });
  it("arbitrates simultaneous replacements without deleting TTL rows first", async () => {
    const h = harness();
    await h.run();
    h.advance(604_800_000);
    const results = await Promise.all([h.run("key", "One", "doc_2"), h.run("key", "Two", "doc_3")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toMatchObject([
      { error: { code: "idempotency.conflict" } },
    ]);
    expect(h.memory.store.resources.size).toBe(2);
    expect(h.memory.idempotency.size).toBe(1);
  });
  it("keeps captured scope/Date private to a persistence factory invocation", async () => {
    const h = harness();
    await h.run();
    const scope = { resourceType: "document", commandName: "create", subject: "user_1" },
      time = new Date(initial);
    const captured = h.memory.factory(scope, time);
    scope.subject = "other";
    time.setUTCFullYear(2030);
    expect(await captured.repository.getIdempotency("key")).toBeDefined();
    expect(await h.memory.factory(scope, time).repository.getIdempotency("key")).toBeUndefined();
  });
});

describe("bounded replay without another mutation decision", () => {
  it("preserves the original error if winner lookup itself becomes unavailable", async () => {
    let reads = 0;
    const h = harness({
      persistence:
        (factory) =>
        (...args) => {
          const base = factory(...args);
          return {
            repository: {
              ...base.repository,
              getIdempotency: async () => {
                if (++reads === 1) return undefined;
                throw new Error("private lookup diagnostics");
              },
            },
            unitOfWork: {
              commit: async () => {
                throw new JawStackRuntimeError(
                  "runtime.unavailable",
                  "Original commit unavailable.",
                );
              },
            },
          };
        },
    });
    expect(await h.run()).toMatchObject({
      ok: false,
      error: { code: "runtime.unavailable", message: "Original commit unavailable." },
    });
    expect(reads).toBe(2);
    expect(h.decisions()).toBe(1);
    expect(h.memory.store.resources.size).toBe(0);
  });
  it("recovers an ambiguous successful commit with stable IDs/time and no second decision", async () => {
    const resourceIds = vi.fn(() => "generated_1"),
      requestIds = vi.fn(() => "original_request");
    const commits = vi.fn();
    const h = harness({
      ids: { resourceId: resourceIds, requestId: requestIds },
      persistence:
        (factory) =>
        (...args) => {
          const base = factory(...args);
          return {
            ...base,
            unitOfWork: {
              commit: async (input) => {
                commits();
                await base.unitOfWork.commit(input);
                throw new JawStackRuntimeError("runtime.unavailable", "Commit response lost.");
              },
            },
          };
        },
    });
    const request: CommandRequest = {
      resourceType: "document",
      commandName: "create",
      input: { title: "Draft" },
      idempotencyKey: "key",
      requestContext: {},
    };
    const result = await h.dispatch(request, auth());
    expect(result).toMatchObject({
      ok: true,
      data: { id: "generated_1" },
      meta: { requestId: "original_request" },
    });
    expect(h.decisions()).toBe(1);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(resourceIds).toHaveBeenCalledTimes(1);
    expect(requestIds).toHaveBeenCalledTimes(1);
    expect(h.clock).toHaveBeenCalledTimes(1);
    expect(h.memory.store.activity).toHaveLength(1);
  });
  it("pins a winner committed between lookup and a stale decision, without replay state reads", async () => {
    let armed = false,
      reads = 0,
      winner: Awaited<ReturnType<ReturnType<typeof harness>["run"]>> | undefined;
    const h = harness({
      persistence:
        (factory) =>
        (...args) => {
          const base = factory(...args);
          return {
            ...base,
            repository: {
              ...base.repository,
              getState: async (type, id) => {
                reads++;
                if (reads > 2) throw new Error("Pinned replay read state.");
                const old = await base.repository.getState(type, id);
                if (armed) {
                  armed = false;
                  winner = await h.dispatch(
                    {
                      ...h.request("edit", "Edited", "doc_1", "edit"),
                      requestId: "winner_request",
                    },
                    auth(),
                  );
                }
                return old;
              },
            },
          };
        },
    });
    await h.run();
    armed = true;
    const result = await h.dispatch(
      { ...h.request("edit", "Edited", "doc_1", "edit"), requestId: "loser_request" },
      auth(),
    );
    expect(result).toEqual(winner);
    expect(result).toMatchObject({ ok: true, meta: { requestId: "winner_request" } });
    expect(reads).toBe(2);
    expect(h.decisions()).toBe(3); // create + two initial edit attempts only
    expect(h.memory.store.activity).toHaveLength(2);
  });
  it("uses all four bounded lookups when a committed response becomes visible late", async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const h = harness({
        persistence:
          (factory) =>
          (...args) => {
            const base = factory(...args);
            return {
              repository: {
                ...base.repository,
                getIdempotency: async (key) => {
                  reads++;
                  return reads < 5 ? undefined : base.repository.getIdempotency(key);
                },
              },
              unitOfWork: {
                commit: async (input) => {
                  await base.unitOfWork.commit(input);
                  throw new JawStackRuntimeError("runtime.unavailable", "Uncertain.");
                },
              },
            };
          },
      });
      const pending = h.run();
      await vi.advanceTimersByTimeAsync(85);
      expect(await pending).toMatchObject({ ok: true });
      expect(reads).toBe(5);
      expect(h.decisions()).toBe(1);
      expect(h.clock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("returns the original failure after four misses; never retries an uncommitted mutation", async () => {
    let reads = 0,
      commits = 0;
    const h = harness({
      persistence:
        (factory) =>
        (...args) => {
          const base = factory(...args);
          return {
            repository: {
              ...base.repository,
              getIdempotency: async () => {
                reads++;
                return undefined;
              },
            },
            unitOfWork: {
              commit: async () => {
                commits++;
                throw new JawStackRuntimeError("runtime.unavailable", "Commit unavailable.");
              },
            },
          };
        },
    });
    expect(await h.run()).toMatchObject({
      ok: false,
      error: { code: "runtime.unavailable", message: "Commit unavailable." },
    });
    expect(reads).toBe(5);
    expect(commits).toBe(1);
    expect(h.decisions()).toBe(1);
    expect(h.memory.store.resources.size).toBe(0);
  });
  it("re-enters the core schema check and will not turn a now-invalid intent into replay success", async () => {
    let permitted = true,
      parses = 0;
    const schema = z.strictObject({
      title: z.string().refine(() => {
        parses++;
        return permitted;
      }),
    });
    const resource = defineResource({
      name: "restricted",
      title: "Restricted",
      state: defineState({ title: field.string() }),
      commands: {
        create: defineCommand({
          title: "Create",
          create: true,
          roles: ["user"],
          input: schema,
          emits: [{ eventType: "restricted.created", schemaVersion: 1 }],
          decide: ({ input }) => ({
            nextState: input,
            activity: [],
            events: [{ eventType: "restricted.created", schemaVersion: 1, payload: input }],
            response: input,
          }),
        }),
      },
    });
    const planner = createWorkflowCommitPlanner({
      workflowName: "restricted",
      source: "restricted",
      idempotencyTtlSeconds: 604800,
    });
    const memory = createMemoryWorkflowPersistence({ planner });
    const dispatch = createWorkflowCommandDispatch({
      registry: [resource],
      source: "restricted",
      clock: () => new Date(initial),
      persistence: (...args) => {
        const base = memory.factory(...args);
        return {
          ...base,
          unitOfWork: {
            commit: async (input) => {
              await base.unitOfWork.commit(input);
              permitted = false;
              throw new JawStackRuntimeError("runtime.unavailable", "Uncertain.");
            },
          },
        };
      },
    });
    expect(
      await dispatch(
        {
          resourceType: "restricted",
          commandName: "create",
          input: { title: "Title" },
          idempotencyKey: "key",
          requestContext: {},
        },
        auth(),
      ),
    ).toMatchObject({ ok: false, error: { code: "command.validation" } });
    expect(parses).toBe(2);
    expect(memory.store.resources.size).toBe(1);
  });
});

describe("memory conditional atomic publication", () => {
  it("publishes only one complete commit when different keys race on the same resource", async () => {
    const h = harness();
    const results = await Promise.all([h.run("one"), h.run("two", "Other")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([
      { error: { code: "resource.conflict" } },
    ]);
    expect(h.memory.store.resources.size).toBe(1);
    expect(h.memory.store.activity).toHaveLength(1);
    expect(h.memory.store.outbox).toHaveLength(1);
    expect(h.memory.store.projections.size).toBe(1);
    expect(h.memory.idempotency.size).toBe(1);
    expect(h.memory.records.size).toBe(1);
  });
  it("rolls back every category on an auxiliary collision and releases the queue for later work", async () => {
    const h = harness();
    const key = memoryPhysicalKey(workflowRecordKeys.record("receipt", "document#doc_1#1"));
    h.memory.records.set(key, {
      collection: "receipt",
      owner: { resourceType: "document", resourceId: "doc_1" },
      value: {},
    });
    const before = h.snapshot();
    expect(await h.run()).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
    expect(h.snapshot()).toEqual(before);
    h.memory.records.delete(key);
    expect(await h.run()).toMatchObject({ ok: true });
  });
  it.each(["activity", "outbox"] as const)(
    "rejects existing immutable %s keys atomically",
    async (kind) => {
      const h = harness();
      await h.run();
      const fresh = harness();
      if (kind === "activity")
        fresh.memory.store.activity.push(structuredClone(h.memory.store.activity[0]!));
      else fresh.memory.store.outbox.push(structuredClone(h.memory.store.outbox[0]!));
      // Deterministic fixture ID counters and instant reproduce the existing physical identity.
      const before = fresh.snapshot();
      expect(await fresh.run()).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
      expect(fresh.snapshot()).toEqual(before);
    },
  );
  it("rejects conflicting projection contributions before publishing state/idempotency", async () => {
    const h = harness({
      contribute: ({ commit }) => ({
        projections: [{ ...commit.projections[0]!, data: { title: "different" } }],
      }),
    });
    const before = h.snapshot();
    expect(await h.run()).toMatchObject({ ok: false, error: { code: "command.rejected" } });
    expect(h.snapshot()).toEqual(before);
  });
  it("moves exact projection keys without deleting other sorts of the same item", async () => {
    const h = harness();
    await h.run();
    const extra = {
      projectionName: "document.list",
      itemId: "doc_1",
      sort: "extra#doc_1",
      data: { extra: true },
    };
    const extraKey = memoryPhysicalKey(workflowRecordKeys.projection("document", extra));
    h.memory.store.projections.set(extraKey, extra);
    expect(await h.dispatch(h.request("edit", "Edited", "doc_1", "edit"), auth())).toMatchObject({
      ok: true,
    });
    const rows = await new InMemoryRepository(h.memory.store).listProjection("document.list");
    expect(rows.map((r) => r.sort).sort()).toEqual(["extra#doc_1", "v2#doc_1"]);
    expect(h.memory.store.projections.get(extraKey)).toEqual(extra);
  });
  it("preserves domain writes made after staging but before the lock continuation", async () => {
    const extra = {
      projectionName: "document.notifications",
      itemId: "notification_1",
      sort: "now#notification_1",
      data: {},
    };
    const extraKey = memoryPhysicalKey(workflowRecordKeys.projection("document", extra));
    const h = harness({
      persistence:
        (factory) =>
        (...args) => {
          const base = factory(...args);
          return {
            ...base,
            unitOfWork: {
              commit: async (input) => {
                const pending = base.unitOfWork.commit(input);
                h.memory.store.projections.set(extraKey, structuredClone(extra));
                await pending;
              },
            },
          };
        },
    });
    expect(await h.run()).toMatchObject({ ok: true });
    expect(h.memory.store.projections.get(extraKey)).toEqual(extra);
  });
  it("returns detached state and rejects another planner or adopting nonempty/shared backing storage", async () => {
    const h = harness();
    await h.run();
    const state = await h.memory.repository.getState("document", "doc_1");
    (state!.state as { title: string }).title = "changed";
    expect((await h.memory.repository.getState("document", "doc_1"))!.state).toEqual({
      title: "Draft",
    });
    const other = harness();
    await expect(other.memory.commit(h.plans[0]!)).rejects.toThrow(/not produced/);
    expect(() =>
      createMemoryWorkflowPersistence({ planner: other.planner, store: h.memory.store }),
    ).toThrow(/owned/);
    const store = new InMemoryStore();
    store.outbox.push(h.memory.store.outbox[0]!);
    expect(() => createMemoryWorkflowPersistence({ planner: other.planner, store })).toThrow(
      /empty/,
    );
  });
  it("rejects broken publication containers before changing any collection", async () => {
    const h = harness();
    Object.freeze(h.memory.store.outbox);
    const before = h.snapshot();
    expect(await h.run()).toMatchObject({ ok: false, error: { code: "resource.invalid_state" } });
    expect(h.snapshot()).toEqual(before);
  });
});

describe("stored workflow validation", () => {
  it.each(["resource", "idempotency", "projection"])(
    "does not treat an explicit undefined %s row as absent",
    async (kind) => {
      const h = harness();
      if (kind === "resource")
        h.memory.store.resources.set("document\u0000doc_1", undefined as never);
      else if (kind === "idempotency")
        h.memory.idempotency.set(
          memoryPhysicalKey(
            workflowRecordKeys.idempotency(
              {
                resourceType: "document",
                commandName: "create",
                subject: "user_1",
              },
              "key",
            ),
          ),
          undefined as never,
        );
      else
        h.memory.store.projections.set(
          memoryPhysicalKey(
            workflowRecordKeys.projection("document", {
              projectionName: "document.list",
              itemId: "doc_1",
              sort: "v1",
            }),
          ),
          undefined as never,
        );
      const before = h.snapshot();
      expect(await h.run()).toMatchObject({ ok: false, error: { code: "resource.invalid_state" } });
      expect(h.snapshot()).toEqual(before);
    },
  );
  it.each(["tenantId", "version", "resourceId"])(
    "rejects corrupt stored resource %s rather than adopting it",
    async (field) => {
      const h = harness();
      await h.run();
      const key = "document\u0000doc_1",
        row = h.memory.store.resources.get(key)!;
      h.memory.store.resources.set(key, {
        ...row,
        [field]: field === "version" ? 0 : "foreign",
      } as ResourceState);
      const before = h.snapshot();
      expect(await h.dispatch(h.request("edit", "Edit", "doc_1", "edit"), auth())).toMatchObject({
        ok: false,
        error: { code: "resource.invalid_state" },
      });
      expect(h.snapshot()).toEqual(before);
    },
  );
  it.each(["tenantId", "expiresAt", "subject", "response"])(
    "rejects corrupt idempotency %s even if the row is logically expired",
    async (field) => {
      const h = harness();
      await h.run();
      const [key, row] = [...h.memory.idempotency][0]!;
      h.memory.idempotency.set(key, {
        ...row,
        [field]:
          field === "expiresAt" ? "invalid" : field === "response" ? { ok: false } : "foreign",
      } as typeof row);
      h.advance(604_800_000);
      const before = h.snapshot();
      expect(await h.run("key", "New", "doc_2")).toMatchObject({
        ok: false,
        error: { code: "resource.invalid_state" },
      });
      expect(h.snapshot()).toEqual(before);
    },
  );
  it("does not hide a corrupt winner behind an eligible original failure", async () => {
    let reads = 0;
    const h = harness({
      persistence:
        (factory) =>
        (...args) => {
          const base = factory(...args);
          return {
            ...base,
            repository: {
              ...base.repository,
              getIdempotency: async () => {
                if (++reads === 1) return undefined;
                return { key: "key", fingerprint: "x", response: { ok: false } } as never;
              },
            },
            unitOfWork: {
              commit: async () => {
                throw new JawStackRuntimeError("runtime.unavailable", "Uncertain.");
              },
            },
          };
        },
    });
    expect(await h.run()).toMatchObject({ ok: false, error: { code: "resource.invalid_state" } });
    expect(h.decisions()).toBe(1);
  });
  it("rejects a corrupt stored projection before a multi-category publication", async () => {
    const h = harness();
    const key = memoryPhysicalKey(
      workflowRecordKeys.projection("document", {
        projectionName: "document.list",
        itemId: "doc_1",
        sort: "v1",
      }),
    );
    h.memory.store.projections.set(key, {
      projectionName: "document.list",
      itemId: "other",
      sort: "v1",
      data: {},
    });
    const before = h.snapshot();
    expect(await h.run()).toMatchObject({ ok: false, error: { code: "resource.invalid_state" } });
    expect(h.snapshot()).toEqual(before);
  });
});

describe("read-only result validation", () => {
  it("freezes hook data/read results, omits context and exposes no write service", async () => {
    const h = harness({
      validateResult: async ({ request, result, repository, clock }) => {
        expect(request).not.toHaveProperty("requestContext");
        expect(Object.keys(repository)).toEqual(["getState"]);
        expect(Object.isFrozen(result)).toBe(true);
        if (result.ok)
          expect(() => {
            (result.data as { title: string }).title = "changed";
          }).toThrow();
        const row = await repository.getState("document", "doc_1");
        expect(() => {
          (row!.state as { title: string }).title = "changed";
        }).toThrow();
        const date = clock();
        date.setUTCFullYear(2030);
        expect(clock().toISOString()).toBe(initial);
      },
    });
    expect(await h.run()).toMatchObject({ ok: true, data: { title: "Draft" } });
  });
  it("rejects stale successful authority after execution and replay without undoing or recommitting", async () => {
    let reject = false;
    const h = harness({
      validateResult: ({ result, clock }) => {
        if (reject && result.ok && clock().getTime() > Date.parse(initial))
          throw new JawStackRuntimeError("resource.conflict", "Authority expired.");
      },
    });
    const first = await h.run();
    h.advance(1000);
    reject = true;
    const before = h.snapshot();
    expect(await h.run()).toMatchObject({
      ok: false,
      error: { code: "resource.conflict" },
      meta: first.meta,
    });
    expect(h.snapshot()).toEqual(before);
    expect(h.decisions()).toBe(1);
    const second = harness({
      validateResult: () => {
        throw new JawStackRuntimeError("resource.conflict", "Already stale.");
      },
    });
    expect(await second.run()).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
    expect(second.memory.store.resources.size).toBe(1);
    expect(second.decisions()).toBe(1);
  });
  it("refuses replacement results and cannot turn an existing error into success", async () => {
    const h = harness({
      validateResult: (() => ({
        ok: true,
        data: "rewritten",
      })) as unknown as WorkflowResultValidator,
    });
    expect(await h.run()).toMatchObject({ ok: false, error: { code: "runtime.internal" } });
    expect(await h.dispatch(h.request(), { ...auth(), roles: [] })).toMatchObject({
      ok: false,
      error: { code: "auth.forbidden" },
    });
    expect(h.memory.store.resources.size).toBe(1);
  });
  it("blocks framework dispatch and direct commits through hook closures", async () => {
    const h = harness({
      validateResult: async () => {
        expect(await h.run("nested", "Nested", "doc_2")).toMatchObject({
          ok: false,
          error: { code: "command.rejected" },
        });
        await expect(h.memory.commit(h.plans[0]!)).rejects.toMatchObject({
          code: "command.rejected",
          message: "Result validation cannot dispatch or commit.",
        });
      },
    });
    expect(await h.run()).toMatchObject({ ok: true });
    expect(h.memory.store.resources.size).toBe(1);
    expect(h.decisions()).toBe(1);
  });
  it("retains read-only restrictions in asynchronous descendants after a hook returns", async () => {
    const resume = deferred();
    let descendant: Promise<void> | undefined;
    const h = harness({
      validateResult: () => {
        descendant = (async () => {
          await resume.promise;
          expect(await h.run("nested", "Nested", "doc_2")).toMatchObject({
            ok: false,
            error: { code: "command.rejected" },
          });
          await expect(h.memory.commit(h.plans[0]!)).rejects.toMatchObject({
            code: "command.rejected",
          });
        })();
      },
    });
    expect(await h.run()).toMatchObject({ ok: true });
    resume.resolve();
    await descendant;
    expect(h.decisions()).toBe(1);
    expect(h.memory.store.resources.size).toBe(1);
  });
  it("isolates concurrent validators instead of globally blocking unrelated invocations", async () => {
    const started = deferred(),
      resume = deferred();
    const h = harness({
      validateResult: async ({ request }) => {
        if (request.idempotencyKey === "blocked") {
          started.resolve();
          await resume.promise;
        }
      },
    });
    const first = h.run("blocked");
    await started.promise;
    expect(await h.run("other", "Other", "doc_2")).toMatchObject({ ok: true });
    resume.resolve();
    expect(await first).toMatchObject({ ok: true });
    expect(h.memory.store.resources.size).toBe(2);
  });
  it("redacts unexpected hook errors and retains original response metadata", async () => {
    const h = harness({
      validateResult: () => {
        throw new Error("private SDK details");
      },
    });
    const result = await h.run();
    expect(result).toMatchObject({
      ok: false,
      error: { code: "runtime.unavailable", message: "Workflow result validation failed." },
    });
    expect(JSON.stringify(result)).not.toContain("private SDK");
    expect(result.meta).toEqual([...h.memory.idempotency.values()][0]!.response.meta);
  });
});

describe("golden memory storage compatibility", () => {
  it("persists frozen legacy state/activity/wire/projection/receipt/idempotency semantics", async () => {
    const golden = JSON.parse(
      readFileSync(
        new URL(
          "../../../docs/iterations/003-framework-leverage/leverage/compatibility.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const input = golden.commandInput;
    const definition = defineAtomicRecord({
      name: "commandReceipt",
      schema: z.strictObject({
        kind: z.literal("commandReceipt"),
        resourceType: z.string(),
        resourceId: z.string(),
        commandName: z.string(),
        subject: z.string(),
        version: z.number(),
        committedAt: z.string(),
      }),
      key: (r) => `${r.resourceType}#${r.resourceId}#${r.version}`,
      owner: (r) => ({ resourceType: r.resourceType, resourceId: r.resourceId }),
    });
    const planner = createWorkflowCommitPlanner({
      workflowName: "content-operations",
      source: "content-operations",
      idempotencyTtlSeconds: 604800,
      records: [definition],
      contribute: ({ invocation, commit }) => ({
        records: [
          definition.create({
            kind: "commandReceipt",
            ...invocation.scope,
            resourceId: commit.resource.resourceId,
            version: commit.resource.next.version,
            committedAt: invocation.now,
          }),
        ],
      }),
    });
    const memory = createMemoryWorkflowPersistence({ planner });
    const scope: WorkflowCommandScope = {
      resourceType: "contentItem",
      commandName: "create",
      subject: "author_1",
    };
    await memory.factory(scope, new Date(initial)).unitOfWork.commit(input);
    expect(await memory.repository.getState("contentItem", input.resource.resourceId)).toEqual(
      input.resource.next,
    );
    expect(memory.store.activity).toEqual(input.activity);
    expect(JSON.stringify(memory.store.outbox[0])).toBe(golden.wireJson);
    expect(
      await memory.factory(scope, new Date(initial)).repository.getIdempotency("fixture-key"),
    ).toEqual(input.idempotency);
    const expected = golden.decodedRows.find(
      (r: { itemKind: string }) => r.itemKind === "APP_OPERATION",
    );
    expect([...memory.records.values()][0]!.value).toEqual(
      Object.fromEntries(
        Object.entries(expected).filter(([key]) => !["PK", "SK", "itemKind"].includes(key)),
      ),
    );
    const projection = golden.decodedRows.find(
      (r: { itemKind: string }) => r.itemKind === "PROJECTION_ITEM",
    );
    expect(
      memory.store.projections.has(JSON.stringify({ PK: projection.PK, SK: projection.SK })),
    ).toBe(true);
  });
});
