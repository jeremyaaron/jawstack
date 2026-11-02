import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineWorkflow,
  createMemoryWorkflow,
  defineResource,
  defineCommand,
  defineAtomicRecord,
  InMemoryStore,
  JawStackRuntimeError,
  type DefineWorkflowInput,
  type WorkflowRuntimeOptions,
  type WorkflowDefinition,
  type JawStackEvent,
} from "@jawstack/core";
import {
  publicWorkflowFixture,
  publicWorkflowInput,
  workflowAuth,
  workflowReceipt,
  testInstant,
} from "./support/public-workflow";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const wire = (): JawStackEvent<Record<string, unknown>> => ({
  envelopeVersion: 1,
  eventId: "event_external",
  eventType: "document.created",
  schemaVersion: 1,
  source: "documents",
  resourceType: "document",
  resourceId: "doc_1",
  correlationId: "correlation",
  occurredAt: testInstant,
  payload: { docId: "doc_1", title: "Draft" },
  actor: { subject: "operator" },
  causationId: "request",
});
function changeCreate(
  payload: Record<string, unknown>,
  projections: readonly {
    projectionName: string;
    itemId: string;
    sort: string;
    data: Record<string, unknown>;
  }[] = [],
): DefineWorkflowInput {
  const base = publicWorkflowInput();
  const resource = base.resources[0]!;
  return {
    ...base,
    resources: [
      defineResource({
        ...resource,
        commands: {
          ...resource.commands,
          create: defineCommand({
            title: "Create",
            create: true,
            roles: ["operator"],
            input: z.strictObject({ title: z.string() }),
            emits: [{ eventType: "document.created", schemaVersion: 1 }],
            decide: () => ({
              nextState: { title: "Draft", done: false },
              response: {},
              activity: [{ activityType: "created", title: "Created" }],
              events: [{ eventType: "document.created", schemaVersion: 1, payload }],
              projections,
            }),
          }),
        },
      }),
    ],
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("public workflow declaration and binding", () => {
  it("blocks deferred startup service calls inherited from a synchronous binding", async () => {
    const resume = deferred();
    let descendant: Promise<void> | undefined;
    const h = publicWorkflowFixture({
      runtime: {
        bind: (services) => {
          descendant = (async () => {
            await resume.promise;
            expect(() => services.repository.getState("document", "doc_1")).toThrow(/binding/);
            expect(() =>
              services.dispatch(
                {
                  resourceType: "document",
                  commandName: "create",
                  input: { title: "Startup" },
                  idempotencyKey: "startup",
                  requestContext: {},
                },
                workflowAuth(),
              ),
            ).toThrow(/binding/);
          })();
          return { process: { handle: () => {} } };
        },
      },
    });
    resume.resolve();
    await descendant;
    expect(h.runtime.store.resources.size).toBe(0);
    expect(await h.create()).toMatchObject({ ok: true });
    await h.runtime.close();
  });
  it("includes command configuration in manifest identity without hashing function bodies", () => {
    const input = publicWorkflowInput(),
      first = defineWorkflow(input);
    const resource = input.resources[0]!,
      command = resource.commands.create!;
    const changed = defineWorkflow({
      ...input,
      resources: [
        defineResource({
          ...resource,
          commands: { ...resource.commands, create: { ...command, roles: ["different"] } },
        }),
      ],
    });
    expect(changed.manifest.hash).not.toBe(first.manifest.hash);
    expect(first.manifest.commandDefinitions.map((c) => c.commandName)).toEqual([
      "create",
      "finish",
    ]);
  });
  it("derives an immutable function-free deterministic manifest from existing worker declarations", () => {
    const input = publicWorkflowInput(["process", "observe"]),
      definition = defineWorkflow(input);
    const reordered = defineWorkflow({
      ...input,
      events: [...input.events].reverse(),
      consumers: { observe: { recovery: "replay" }, process: { recovery: "replay" } },
    });
    expect(reordered.manifest).toEqual(definition.manifest);
    expect(definition.manifest.consumers.map((c) => [c.name, c.eventTypes])).toEqual([
      ["observe", ["document.created"]],
      ["process", ["document.created"]],
    ]);
    expect(Object.isFrozen(definition.manifest.consumers[0]!.eventTypes)).toBe(true);
    expect(JSON.stringify(definition.manifest)).not.toMatch(
      /Zod|decide|handle|validateIdentity|schema"/,
    );
    expect(definition.manifest.hash).toMatch(/^[a-f0-9]{64}$/);
    const policies = { process: { recovery: "replay" as const } };
    const snapshot = defineWorkflow({ ...publicWorkflowInput(), consumers: policies });
    (policies.process as { recovery: string }).recovery = "application";
    expect(snapshot.manifest.consumers[0]!.recovery).toBe("replay");
  });
  it("creates no clients, application I/O or timers during definition and synchronous binding", async () => {
    const fetch = vi.spyOn(globalThis, "fetch"),
      timers = vi.spyOn(globalThis, "setTimeout"),
      clock = vi.fn(() => new Date(testInstant));
    const h = publicWorkflowFixture({ runtime: { clock } });
    expect(fetch).not.toHaveBeenCalled();
    expect(timers).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
    expect(h.runtime.inspect().jobs).toEqual([]);
    await h.runtime.close();
  });
  it.each([
    "missingPolicy",
    "extraPolicy",
    "inheritedPolicy",
    "duplicateWorker",
    "duplicateEvent",
    "duplicateEmission",
    "missingEvent",
    "unknownSubscription",
    "mixedBounds",
    "reservedPayload",
    "badNamespace",
    "unknownOption",
    "badTtl",
  ])("rejects invalid declaration: %s", (kind) => {
    const base = publicWorkflowInput(["process", "observe"]);
    let input: DefineWorkflowInput = base;
    if (kind === "missingPolicy")
      input = { ...base, consumers: { process: { recovery: "replay" } } };
    else if (kind === "extraPolicy")
      input = { ...base, consumers: { ...base.consumers, extra: { recovery: "replay" } } };
    else if (kind === "inheritedPolicy")
      input = {
        ...base,
        consumers: Object.create(base.consumers) as DefineWorkflowInput["consumers"],
      };
    else if (kind === "duplicateWorker")
      input = {
        ...base,
        resources: [base.resources[0]!, defineResource({ ...base.resources[0]!, name: "other" })],
      };
    else if (kind === "duplicateEvent")
      input = { ...base, events: [...base.events, base.events[0]!] };
    else if (kind === "duplicateEmission") {
      const resource = base.resources[0]!,
        command = resource.commands.create!;
      input = {
        ...base,
        resources: [
          defineResource({
            ...resource,
            commands: {
              ...resource.commands,
              create: { ...command, emits: [...command.emits, ...command.emits] },
            },
          }),
        ],
      };
    } else if (kind === "missingEvent") input = { ...base, events: [] };
    else if (kind === "unknownSubscription")
      input = {
        ...base,
        resources: [
          defineResource({
            ...base.resources[0]!,
            workers: [
              { name: "process", eventTypes: ["document.unknown"] },
              { name: "observe", eventTypes: ["document.created"] },
            ],
          }),
        ],
      };
    else if (kind === "mixedBounds")
      input = {
        ...base,
        consumers: {
          process: { recovery: "replay" },
          observe: { recovery: "replay", batchSize: 2 },
        },
      };
    else if (kind === "reservedPayload")
      input = {
        ...base,
        events: [
          { ...base.events[0]!, schema: z.object({ delivery: z.unknown() }) },
          base.events[1]!,
        ],
      };
    else if (kind === "badNamespace")
      input = { ...base, operations: { resourceType: "foreign", projection: "foreign.failures" } };
    else if (kind === "badTtl") input = { ...base, commands: { idempotencyTtlSeconds: 0 } };
    else input = { ...base, surprise: true } as DefineWorkflowInput;
    expect(() => defineWorkflow(input)).toThrow();
  });
  it.each(["missing", "extra", "inherited", "missingHandler", "unknownHook", "async"])(
    "rejects invalid consumer binding: %s",
    (kind) => {
      const definition = defineWorkflow(publicWorkflowInput());
      const normal = { process: { handle: () => {} } };
      const bind =
        kind === "missing"
          ? () => ({})
          : kind === "extra"
            ? () => ({ ...normal, extra: normal.process })
            : kind === "inherited"
              ? () => Object.create(normal) as typeof normal
              : kind === "missingHandler"
                ? () => ({ process: {} })
                : kind === "unknownHook"
                  ? () => ({ process: { ...normal.process, unknown: () => {} } })
                  : async () => normal;
      expect(() =>
        createMemoryWorkflow(definition, { bind: bind as WorkflowRuntimeOptions["bind"] }),
      ).toThrow();
    },
  );
  it.each(["dispatch", "state", "query", "records", "operations"])(
    "rejects %s during binding even when the callback catches the error",
    (kind) => {
      const definition = defineWorkflow(publicWorkflowInput()),
        store = new InMemoryStore();
      expect(() =>
        createMemoryWorkflow(definition, {
          store,
          bind: (services) => {
            try {
              if (kind === "dispatch")
                void services.dispatch(
                  {
                    resourceType: "document",
                    commandName: "create",
                    input: { title: "No" },
                    idempotencyKey: "binding",
                    requestContext: {},
                  },
                  workflowAuth(),
                );
              else if (kind === "state") void services.repository.getState("document", "doc_1");
              else if (kind === "query")
                void services.queries.queryProjection({ projectionName: "document.list" });
              else if (kind === "records") void services.records.get(workflowReceipt, "doc_1#1");
              else void services.operations.inspect(workflowAuth());
            } catch {
              /* Catching does not erase a forbidden startup operation. */
            }
            return { process: { handle: () => {} } };
          },
        }),
      ).toThrow(/binding|Binding/);
      expect(store.resources.size).toBe(0);
      expect(store.outbox).toHaveLength(0);
    },
  );
  it("rejects a forged definition and remounting a previously owned store", async () => {
    const original = defineWorkflow(publicWorkflowInput());
    expect(() =>
      createMemoryWorkflow({ ...original } as WorkflowDefinition, {
        bind: () => ({ process: { handle: () => {} } }),
      }),
    ).toThrow(/owned/);
    const store = new InMemoryStore(),
      h = publicWorkflowFixture({ runtime: { store } });
    await h.runtime.close();
    expect(() => publicWorkflowFixture({ runtime: { store } })).toThrow(/owned/);
  });
});

describe("public commands, facts and registered records", () => {
  it("preserves read-only result validation across public service wrappers", async () => {
    let seen = false;
    const h = publicWorkflowFixture({
      runtime: {
        validateResult: async ({ result }) => {
          if (!result.ok) return;
          seen = true;
          expect(await h.create("nested")).toMatchObject({
            ok: false,
            error: { code: "command.rejected" },
          });
          expect(() => h.runtime.drain()).toThrow(/Result validation/);
        },
      },
    });
    expect(await h.create()).toMatchObject({ ok: true });
    expect(seen).toBe(true);
    expect(h.runtime.store.resources.size).toBe(1);
    await h.runtime.close();
  });
  it("runs commands and a domain handler with only public services, including typed record reads", async () => {
    const h = publicWorkflowFixture();
    expect(await h.create("doc_1", "  Draft  ")).toMatchObject({ ok: true });
    const record = await h.runtime.records.get(workflowReceipt, "doc_1#1");
    expect(record).toEqual({ resourceId: "doc_1", version: 1 });
    record!.version = 99;
    expect((await h.runtime.records.get(workflowReceipt, "doc_1#1"))!.version).toBe(1);
    expect(await h.runtime.drainUntilIdle()).toMatchObject({ idle: true });
    expect(await h.runtime.repository.getState("document", "doc_1")).toMatchObject({
      version: 2,
      state: { title: "Draft", done: true },
    });
    expect(await h.runtime.records.get(workflowReceipt, "doc_1#2")).toEqual({
      resourceId: "doc_1",
      version: 2,
    });
    expect(h.runtime.store.activity).toHaveLength(2);
    expect(h.runtime.store.idempotency.size).toBe(0);
    await h.runtime.close();
  });
  it("captures a public invocation immediately and never inspects ingress context", async () => {
    const h = publicWorkflowFixture();
    const auth = workflowAuth();
    const request = {
      resourceType: "document",
      resourceId: "doc_1",
      commandName: "create",
      input: { title: "Original" },
      idempotencyKey: "key",
      requestContext: {},
    };
    Object.defineProperty(request, "requestContext", {
      get: () => {
        throw new Error("Do not read");
      },
    });
    const pending = h.runtime.dispatch(request, auth);
    request.input.title = "Changed";
    (auth.roles as string[]).length = 0;
    expect(await pending).toMatchObject({ ok: true });
    expect((await h.runtime.repository.getState("document", "doc_1"))!.state).toMatchObject({
      title: "Original",
    });
    await h.runtime.close();
  });
  it("rejects an unregistered record identity even if its name matches", async () => {
    const h = publicWorkflowFixture();
    await h.create();
    const other = defineAtomicRecord({
      name: "receipt",
      schema: z.object({ resourceId: z.string(), version: z.number() }),
      key: (r) => `${r.resourceId}#${r.version}`,
      owner: (r) => ({ resourceType: "document", resourceId: r.resourceId }),
    });
    await expect(h.runtime.records.get(other, "doc_1#1")).rejects.toMatchObject({
      code: "command.rejected",
    });
    await expect(
      h.runtime.queries.queryProjection({ projectionName: "document.failures" }),
    ).rejects.toMatchObject({ code: "auth.forbidden" });
    await h.runtime.close();
  });
  it("canonicalizes schema payloads and wrapped facts while rejecting wrapper mismatches", async () => {
    const h = publicWorkflowFixture();
    const fact = wire();
    fact.payload.title = "  Draft  ";
    expect(h.runtime.events.parse(fact).payload.title).toBe("Draft");
    expect(
      h.runtime.events.parse({
        source: fact.source,
        "detail-type": fact.eventType,
        detail: JSON.stringify(fact),
      }),
    ).toEqual(h.runtime.events.parse(fact));
    for (const bad of [
      { source: "foreign", detail: fact },
      { "detail-type": "document.finished", detail: fact },
      { tenantId: "tenant", detail: fact },
    ])
      expect(() => h.runtime.events.parse(bad)).toThrow(/Invalid workflow/);
    await h.runtime.close();
  });
  it.each(["version", "source", "identity", "schema", "tenant", "legacyRecovery"])(
    "rejects invalid fact %s before delivery or markers",
    async (kind) => {
      const calls = vi.fn();
      const h = publicWorkflowFixture({
        runtime: { bind: () => ({ process: { handle: calls } }) },
      });
      const fact = wire();
      const bad =
        kind === "version"
          ? { ...fact, schemaVersion: 2 }
          : kind === "source"
            ? { ...fact, source: "other" }
            : kind === "identity"
              ? { ...fact, resourceId: "other" }
              : kind === "schema"
                ? { ...fact, payload: { ...fact.payload, secret: "private" } }
                : kind === "tenant"
                  ? { ...fact, tenantId: "tenant" }
                  : {
                      ...fact,
                      payload: {
                        ...fact.payload,
                        delivery: { originalEventId: "old", generation: 1 },
                      },
                    };
      await expect(h.runtime.delivery.handle("process", bad)).rejects.toMatchObject({
        code: "command.validation",
      });
      expect(calls).not.toHaveBeenCalled();
      expect(h.runtime.inspect().markers.delivery).toBe(0);
      await h.runtime.close();
    },
  );
  it("rejects command-authored recovery metadata before any transaction", async () => {
    const h = publicWorkflowFixture({
      input: changeCreate({
        docId: "doc_1",
        title: "Draft",
        delivery: {
          originalEventId: "old",
          generation: 1,
          consumer: "process",
          failureId: "0".repeat(64),
        },
      }),
    });
    expect(await h.create()).toMatchObject({ ok: false, error: { code: "command.validation" } });
    expect(h.runtime.store.resources.size).toBe(0);
    expect(h.runtime.store.outbox).toHaveLength(0);
    await h.runtime.close();
  });
  it.each(["decision", "contribution"])(
    "reserves operational projections against %s writes",
    async (kind) => {
      const projection = {
        projectionName: "document.failures",
        itemId: "doc_1",
        sort: "now",
        data: {},
      };
      const input =
        kind === "decision"
          ? changeCreate({ docId: "doc_1", title: "Draft" }, [projection])
          : { ...publicWorkflowInput(), contribute: () => ({ projections: [projection] }) };
      const h = publicWorkflowFixture({ input });
      expect(await h.create()).toMatchObject({ ok: false, error: { code: "command.rejected" } });
      expect(h.runtime.store.resources.size).toBe(0);
      expect(h.runtime.store.projections.size).toBe(0);
      await h.runtime.close();
    },
  );
});

describe("public failure to replay completion", () => {
  it("runs request -> command -> retries -> failure -> authorized replay -> business and ledger completion", async () => {
    let fail = true;
    const h = publicWorkflowFixture({
      beforeHandle: () => {
        if (fail) throw new Error("private provider credential");
      },
    });
    await h.create();
    expect(await h.runtime.drain()).toMatchObject({ retried: 1, pending: 1 });
    expect(await h.runtime.drainUntilIdle()).toMatchObject({
      idle: false,
      result: { attempted: 0, pending: 1, nextAttemptAt: "2026-11-01T12:00:01.000Z" },
    });
    h.advance(1000);
    expect(await h.runtime.drain()).toMatchObject({ retried: 1 });
    h.advance(1999);
    expect(await h.runtime.drain()).toMatchObject({ attempted: 0 });
    h.advance(1);
    expect(await h.runtime.drain()).toMatchObject({ failed: 1, collected: 1, terminal: 0 });
    const page = await h.runtime.operations.inspect(workflowAuth());
    if (!("items" in page)) throw new Error();
    expect(page.items).toHaveLength(1);
    const failure = page.items[0]!;
    expect(failure).toMatchObject({ status: "failed", resolution: "notApplicable" });
    expect(JSON.stringify([page, h.runtime.inspect()])).not.toMatch(
      /credential|operator-secret|payload|fingerprint/,
    );
    await expect(
      h.runtime.operations.replay(failure.id, { ...workflowAuth(), roles: [] }, randomUUID()),
    ).rejects.toMatchObject({ code: "auth.forbidden" });
    fail = false;
    const request = randomUUID();
    await h.runtime.operations.replay(failure.id, workflowAuth(), request);
    expect(await h.runtime.drainUntilIdle()).toMatchObject({ idle: true });
    expect(await h.runtime.repository.getState("document", "doc_1")).toMatchObject({
      version: 2,
      state: { done: true },
    });
    expect(await h.runtime.operations.inspect(workflowAuth(), { id: failure.id })).toMatchObject({
      status: "resolved",
      generation: 1,
    });
    const before = h.runtime.store.activity.length;
    await h.runtime.operations.replay(failure.id, workflowAuth(), request);
    await h.runtime.drainUntilIdle();
    expect(h.runtime.store.activity).toHaveLength(before);
    await h.runtime.close();
  });
  it("authenticates ignored fanout copies and stale/forged recoveries even on marker hits", async () => {
    let fail = true;
    const process = vi.fn(() => {
      if (fail) throw new Error("worker failed");
    });
    const observer = vi.fn();
    const h = publicWorkflowFixture({
      input: publicWorkflowInput(["process", "observe"]),
      runtime: { bind: () => ({ process: { handle: process }, observe: { handle: observer } }) },
    });
    await h.create();
    await h.runtime.drain();
    h.advance(1000);
    await h.runtime.drain();
    h.advance(2000);
    await h.runtime.drain();
    const page = await h.runtime.operations.inspect(workflowAuth());
    if (!("items" in page)) throw new Error();
    const failure = page.items[0]!;
    await h.runtime.operations.replay(failure.id, workflowAuth(), randomUUID());
    const recovery = h.runtime.store.outbox.at(-1)!;
    expect(await h.runtime.delivery.handle("observe", recovery)).toEqual({ status: "ignored" });
    expect(observer).toHaveBeenCalledTimes(1);
    fail = false;
    expect(await h.runtime.delivery.handle("process", recovery)).toEqual({ status: "processed" });
    expect(await h.runtime.delivery.handle("process", recovery)).toEqual({ status: "duplicate" });
    const calls = process.mock.calls.length;
    const forged = { ...recovery, payload: { ...(recovery.payload as object), title: "forged" } };
    await expect(h.runtime.delivery.handle("process", forged)).rejects.toMatchObject({
      code: "command.rejected",
    });
    await expect(h.runtime.delivery.handle("observe", forged)).rejects.toMatchObject({
      code: "command.rejected",
    });
    expect(process).toHaveBeenCalledTimes(calls);
    await h.runtime.close();
  });
  it("retains pending collection when a live application claim defers reconciliation", async () => {
    let live = true;
    const h = publicWorkflowFixture({
      runtime: {
        bind: () => ({
          process: {
            handle: () => {
              throw new Error("exhausted");
            },
            reconcileFailure: () => {
              if (live) throw new JawStackRuntimeError("resource.conflict", "Live claim.");
              return "stalled";
            },
          },
        }),
      },
    });
    await h.create();
    await h.runtime.drain();
    h.advance(1000);
    await h.runtime.drain();
    h.advance(2000);
    expect(await h.runtime.drain()).toMatchObject({ terminal: 1, collectionFailed: 1 });
    const page = await h.runtime.operations.inspect(workflowAuth());
    if (!("items" in page)) throw new Error();
    expect(page.items[0]).toMatchObject({ status: "reconciling", resolution: "pending" });
    expect(h.runtime.inspect().markers.collection).toBe(0);
    expect(await h.runtime.drain()).toMatchObject({ collectionFailed: 0 });
    live = false;
    h.advance(1000);
    expect(await h.runtime.drain()).toMatchObject({ collected: 1, terminal: 0 });
    expect(h.runtime.inspect().markers.collection).toBe(1);
    await h.runtime.close();
  });
});

describe("bounded memory admission and lifecycle", () => {
  it("does not re-enter worker retries for an already collected duplicate transport fact", async () => {
    const handle = vi.fn(() => {
      throw new Error("provider failed");
    });
    const h = publicWorkflowFixture({ runtime: { bind: () => ({ process: { handle } }) } });
    await h.create();
    await h.runtime.drain();
    h.advance(1000);
    await h.runtime.drain();
    h.advance(2000);
    await h.runtime.drain();
    expect(handle).toHaveBeenCalledTimes(3);
    expect(h.runtime.inspect().markers.collection).toBe(1);
    h.runtime.store.outbox.push(structuredClone(h.runtime.store.outbox[0]!));
    expect(await h.runtime.drain()).toMatchObject({
      scanned: 1,
      attempted: 0,
      pending: 0,
      terminal: 0,
    });
    expect(handle).toHaveBeenCalledTimes(3);
    await h.runtime.close();
  });
  it("admits full fanout or nothing and leaves its cursor at a backpressured event", async () => {
    const calls = vi.fn();
    const h = publicWorkflowFixture({
      input: publicWorkflowInput(["process", "observe"]),
      runtime: {
        memory: { maxJobs: 1 },
        bind: () => ({ process: { handle: calls }, observe: { handle: calls } }),
      },
    });
    await h.create();
    expect(await h.runtime.drain()).toMatchObject({ scanned: 0, backpressured: true, pending: 0 });
    expect(h.runtime.inspect().cursor).toBe(0);
    expect(calls).not.toHaveBeenCalled();
    await h.runtime.close();
  });
  it("keeps deferred work at the job cap without eviction or clock advancement", async () => {
    const h = publicWorkflowFixture({
      beforeHandle: () => {
        throw new Error("failure");
      },
      runtime: { memory: { maxJobs: 1 } },
    });
    await h.create("doc_1");
    await h.create("doc_2");
    expect(await h.runtime.drainUntilIdle()).toMatchObject({
      idle: false,
      result: { backpressured: true, pending: 1 },
    });
    expect(h.runtime.inspect()).toMatchObject({
      cursor: 1,
      jobs: [{ attempts: 1, dueAt: "2026-11-01T12:00:01.000Z" }],
    });
    expect((await h.runtime.repository.getState("document", "doc_1"))!.updatedAt).toBe(testInstant);
    await h.runtime.close();
  });
  it("backpressures processing markers without evicting live deduplication", async () => {
    const h = publicWorkflowFixture({ runtime: { memory: { maxMarkers: 1 } } });
    await h.create("doc_1");
    await h.create("doc_2");
    const result = await h.runtime.drainUntilIdle();
    expect(result.idle).toBe(false);
    expect(h.runtime.inspect().markers.delivery).toBe(1);
    expect((await h.runtime.repository.getState("document", "doc_2"))!.version).toBe(1);
    expect(h.runtime.inspect().jobs[0]!.attempts).toBe(0);
    h.advance(604800000);
    expect(await h.runtime.drainUntilIdle()).toMatchObject({ idle: true });
    expect((await h.runtime.repository.getState("document", "doc_2"))!.version).toBe(2);
    await h.runtime.close();
  });
  it("backpressures collector markers without dropping terminal jobs", async () => {
    const h = publicWorkflowFixture({
      beforeHandle: () => {
        throw new Error("failure");
      },
      runtime: { memory: { maxCollectionMarkers: 1 } },
    });
    await h.create("doc_1");
    await h.create("doc_2");
    await h.runtime.drain();
    h.advance(1000);
    await h.runtime.drain();
    h.advance(2000);
    await h.runtime.drain();
    expect(h.runtime.inspect()).toMatchObject({
      markers: { collection: 1 },
      jobs: [{ status: "failed" }],
    });
    const page = await h.runtime.operations.inspect(workflowAuth());
    if (!("items" in page)) throw new Error();
    expect(page.items).toHaveLength(1);
    h.advance(604800000);
    await h.runtime.drain();
    expect(h.runtime.inspect().jobs).toHaveLength(0);
    await h.runtime.close();
  });
  it("bounds failure retention without evicting durable histories or terminal work", async () => {
    const h = publicWorkflowFixture({
      beforeHandle: () => {
        throw new Error("failure");
      },
      runtime: { memory: { maxFailures: 1 } },
    });
    await h.create("doc_1");
    await h.create("doc_2");
    await h.runtime.drain();
    h.advance(1000);
    await h.runtime.drain();
    h.advance(2000);
    expect(await h.runtime.drain()).toMatchObject({
      terminal: 1,
      collected: 1,
      collectionFailed: 1,
    });
    const page = await h.runtime.operations.inspect(workflowAuth());
    if (!("items" in page)) throw new Error();
    expect(page.items).toHaveLength(1);
    await h.runtime.close();
  });
  it("rejects outbox reset or a changed consumed boundary", async () => {
    for (const reset of [true, false]) {
      const h = publicWorkflowFixture();
      await h.create();
      await h.runtime.drainUntilIdle();
      if (reset) h.runtime.store.outbox.length = 0;
      else
        h.runtime.store.outbox[h.runtime.inspect().cursor - 1] = {
          ...h.runtime.store.outbox.at(-1)!,
          eventId: "changed",
        };
      await expect(h.runtime.drain()).rejects.toMatchObject({ code: "resource.invalid_state" });
      await h.runtime.close();
    }
  });
  it("rejects transport identity reuse even when the original processing marker exists", async () => {
    const h = publicWorkflowFixture();
    await h.create();
    await h.runtime.drainUntilIdle();
    const original = h.runtime.store.outbox[0]!;
    h.runtime.store.outbox.push({
      ...original,
      payload: { ...(original.payload as object), title: "changed" },
    });
    await expect(h.runtime.drain()).rejects.toMatchObject({ code: "resource.conflict" });
    expect(h.runtime.store.activity).toHaveLength(2);
    await h.runtime.close();
  });
  it("serializes concurrent drains and bounds drain-until-idle passes", async () => {
    const entered = deferred(),
      resume = deferred();
    let calls = 0;
    const h = publicWorkflowFixture({
      beforeHandle: async () => {
        calls++;
        entered.resolve();
        await resume.promise;
      },
    });
    await h.create();
    const first = h.runtime.drain();
    await entered.promise;
    const second = h.runtime.drain();
    expect(calls).toBe(1);
    resume.resolve();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    await h.create("doc_2");
    await h.create("doc_3");
    expect(await h.runtime.drainUntilIdle({ maxPasses: 1, limit: 1 })).toMatchObject({
      exhausted: true,
      idle: false,
    });
    await h.runtime.drainUntilIdle();
    await h.runtime.close();
  });
  it("starts only explicitly, stops its timer, and permits a later serialized driver", async () => {
    vi.useFakeTimers();
    const h = publicWorkflowFixture();
    expect(vi.getTimerCount()).toBe(0);
    const driver = h.runtime.start({ intervalMs: 100 });
    expect(() => h.runtime.start()).toThrow(/running/);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await h.create();
    await vi.advanceTimersByTimeAsync(100);
    expect((await h.runtime.repository.getState("document", "doc_1"))!.version).toBe(2);
    await driver.stop();
    expect(vi.getTimerCount()).toBe(0);
    const restarted = h.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    await restarted.stop();
    await h.runtime.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("aborts cooperative work and waits before closing; closed services cannot execute", async () => {
    const entered = deferred();
    const h = publicWorkflowFixture({
      runtime: {
        bind: () => ({
          process: {
            handle: async (_event, { signal }) => {
              entered.resolve();
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), { once: true }),
              );
            },
          },
        }),
      },
    });
    await h.create();
    const drain = h.runtime.drain(50, new AbortController().signal);
    const rejected = expect(drain).rejects.toThrow();
    await entered.promise;
    await h.runtime.close();
    await rejected;
    expect(h.runtime.inspect().markers.delivery).toBe(0);
    expect(h.runtime.inspect().jobs[0]!.attempts).toBe(0);
    expect(h.runtime.store.activity).toHaveLength(1);
    expect(await h.create("closed")).toMatchObject({
      ok: false,
      error: { code: "runtime.unavailable" },
    });
    expect(() => h.runtime.start()).toThrow(/closed/);
    await h.runtime.close();
  });
  it("reports a bounded stop/close timeout for uncooperative work, then can finish cleanup", async () => {
    vi.useFakeTimers();
    const entered = deferred(),
      resume = deferred();
    const h = publicWorkflowFixture({
      runtime: {
        bind: () => ({
          process: {
            handle: async () => {
              entered.resolve();
              await resume.promise;
            },
          },
        }),
      },
    });
    await h.create();
    const driver = h.runtime.start();
    await entered.promise;
    const stop = expect(driver.stop({ timeoutMs: 5 })).rejects.toMatchObject({
      code: "runtime.unavailable",
    });
    await vi.advanceTimersByTimeAsync(5);
    await stop;
    const close = expect(h.runtime.close({ timeoutMs: 5 })).rejects.toMatchObject({
      code: "runtime.unavailable",
    });
    await vi.advanceTimersByTimeAsync(5);
    await close;
    resume.resolve();
    await driver.done;
    await h.runtime.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects pump reentry from a handler instead of waiting on itself", async () => {
    const h = publicWorkflowFixture({
      runtime: {
        bind: () => ({
          process: {
            handle: async () => {
              expect(() => h.runtime.drain()).toThrow(/own pump/);
              expect(() => h.runtime.start()).toThrow(/own driver/);
            },
          },
        }),
      },
    });
    await h.create();
    expect(await h.runtime.drain()).toMatchObject({ succeeded: 1 });
    await h.runtime.close();
  });
  it.each([0, -1, 10001, 1.5])("rejects invalid memory capacity %s before binding", (maximum) => {
    const bind = vi.fn(() => ({ process: { handle: () => {} } }));
    expect(() =>
      publicWorkflowFixture({ runtime: { memory: { maxJobs: maximum }, bind } }),
    ).toThrow(/capacity/);
    expect(bind).not.toHaveBeenCalled();
  });
});
