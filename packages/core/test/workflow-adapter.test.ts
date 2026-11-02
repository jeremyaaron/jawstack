import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createWorkflowRuntime,
  defineWorkflow,
  InMemoryRepository,
  defineResource,
  defineState,
  defineCommand,
  defineWorker,
  field,
  JawStackRuntimeError,
  type WorkflowStorage,
  type WorkflowRuntimeOptions,
  type WorkflowServices,
  type JawStackEvent,
} from "@jawstack/core";
import { createMemoryWorkflowPersistence, memoryPhysicalKey } from "../src/workflow/memory";
import { createMemoryWorkflowFailureStore } from "../src/workflow/failure-memory";
import { createMemoryWorkflowMarkers } from "../src/workflow/delivery";
import { workflowRecordKeys } from "../src/workflow/keys";
import {
  publicWorkflowInput,
  workflowAuth,
  testInstant,
  workflowReceipt,
} from "./support/public-workflow";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
// Adapter fault injection deliberately uses the real internal memory ports, not protocol copies.
function adapter(
  options: {
    wrap?: (ports: WorkflowStorage) => WorkflowStorage;
    bind?: WorkflowRuntimeOptions["bind"];
  } = {},
) {
  const definition = defineWorkflow(publicWorkflowInput(["process", "observe"]));
  let memory!: ReturnType<typeof createMemoryWorkflowPersistence>, ports!: WorkflowStorage;
  const runtime = createWorkflowRuntime(
    definition,
    (spec) => {
      memory = createMemoryWorkflowPersistence({ planner: spec.planner });
      const repository = new InMemoryRepository(memory.store);
      ports = {
        command: memory.factory,
        repository,
        queries: repository,
        records: {
          get: async (name, key) =>
            memory.records.get(memoryPhysicalKey(workflowRecordKeys.record(name, key))),
        },
        failures: createMemoryWorkflowFailureStore({
          persistence: memory,
          protocol: spec.protocol,
        }),
        markers: createMemoryWorkflowMarkers(1000, 1000),
      };
      return options.wrap?.(ports) ?? ports;
    },
    {
      clock: () => new Date(testInstant),
      authorizeOperations: (auth) => auth.subject === "operator",
      bind:
        options.bind ?? (() => ({ process: { handle: () => {} }, observe: { handle: () => {} } })),
    },
  );
  const original: JawStackEvent<Record<string, unknown>> = {
    envelopeVersion: 1,
    eventId: "original",
    eventType: "document.created",
    schemaVersion: 1,
    source: "documents",
    resourceType: "document",
    resourceId: "doc_1",
    correlationId: "correlation",
    occurredAt: testInstant,
    payload: { docId: "doc_1", title: "Draft" },
  };
  const queue = async () => {
    await runtime.delivery.collect("process", original);
    const page = await runtime.operations.inspect(workflowAuth());
    if (!("items" in page)) throw new Error();
    const id = page.items[0]!.id;
    await runtime.operations.replay(id, workflowAuth(), randomUUID());
    return { id, wire: memory.store.outbox.at(-1)! };
  };
  return { runtime, original, queue, memory: () => memory, ports: () => ports };
}

describe("workflow adapter ordering and faults", () => {
  it("writes recovery completion after business completion and before the processing marker", async () => {
    const order: string[] = [];
    const h = adapter({
      bind: () => ({
        process: {
          handle: () => {
            order.push("business");
          },
        },
        observe: { handle: () => {} },
      }),
      wrap: (ports) => ({
        ...ports,
        failures: {
          ...ports.failures,
          commit: async (...args) => {
            await ports.failures.commit(...args);
            if (args[1].resolvedGeneration === 1) order.push("completion");
          },
        },
        markers: {
          ...ports.markers,
          write: async (...args) => {
            await ports.markers.write(...args);
            if (args[0] === "process") order.push("marker");
          },
        },
      }),
    });
    const replay = await h.queue();
    await h.runtime.delivery.handle("process", replay.wire);
    expect(order).toEqual(["business", "completion", "marker"]);
    await h.runtime.close();
  });
  it("authenticates targeted facts before all marker reads, including collection and ignored fanout", async () => {
    const check = vi.fn<WorkflowStorage["markers"]["check"]>();
    const h = adapter({
      wrap: (ports) => ({
        ...ports,
        markers: {
          ...ports.markers,
          check: (...args) => {
            check(...args);
            return ports.markers.check(...args);
          },
        },
      }),
    });
    const replay = await h.queue();
    await h.runtime.delivery.handle("process", replay.wire);
    check.mockClear();
    const forged = {
      ...replay.wire,
      payload: { ...(replay.wire.payload as object), title: "forged" },
    };
    for (const name of ["process", "observe"]) {
      await expect(h.runtime.delivery.handle(name, forged)).rejects.toMatchObject({
        code: "command.rejected",
      });
      await expect(h.runtime.delivery.collect(name, forged)).rejects.toMatchObject({
        code: "command.rejected",
      });
    }
    expect(check).not.toHaveBeenCalled();
    expect(await h.runtime.delivery.handle("observe", replay.wire)).toEqual({ status: "ignored" });
    expect(check).not.toHaveBeenCalled();
    await h.runtime.close();
  });
  it("does not mark success when durable recovery completion fails after a business effect", async () => {
    let block = true,
      effects = 0;
    const h = adapter({
      bind: () => ({
        process: {
          handle: () => {
            if (effects) return "ignored";
            effects++;
          },
        },
        observe: { handle: () => {} },
      }),
      wrap: (ports) => ({
        ...ports,
        failures: {
          ...ports.failures,
          commit: async (...args) => {
            if (block && args[1].resolvedGeneration === 1)
              throw new JawStackRuntimeError("runtime.unavailable", "Unavailable.");
            return ports.failures.commit(...args);
          },
        },
      }),
    });
    const replay = await h.queue();
    await expect(h.runtime.delivery.handle("process", replay.wire)).rejects.toMatchObject({
      code: "runtime.unavailable",
    });
    expect(await h.ports().markers.check("process", replay.wire, new Date(testInstant))).toBe(
      "available",
    );
    expect(effects).toBe(1);
    block = false;
    expect(await h.runtime.delivery.handle("process", replay.wire)).toEqual({ status: "ignored" });
    expect(await h.runtime.operations.inspect(workflowAuth(), { id: replay.id })).toMatchObject({
      status: "resolved",
    });
    expect(effects).toBe(1);
    await h.runtime.close();
  });
  it("retries safely after a lost marker write without claiming exactly-once handler invocation", async () => {
    let effects = 0,
      calls = 0,
      fail = true;
    const h = adapter({
      bind: () => ({
        process: {
          handle: () => {
            calls++;
            if (effects) return "ignored";
            effects++;
          },
        },
        observe: { handle: () => {} },
      }),
      wrap: (ports) => ({
        ...ports,
        markers: {
          ...ports.markers,
          write: async (...args) => {
            if (args[0] === "process" && fail) {
              fail = false;
              throw new JawStackRuntimeError("runtime.unavailable", "Marker unavailable.");
            }
            await ports.markers.write(...args);
          },
        },
      }),
    });
    const replay = await h.queue();
    await expect(h.runtime.delivery.handle("process", replay.wire)).rejects.toMatchObject({
      code: "runtime.unavailable",
    });
    expect(await h.runtime.operations.inspect(workflowAuth(), { id: replay.id })).toMatchObject({
      status: "resolved",
    });
    await h.runtime.delivery.handle("process", replay.wire);
    expect(await h.runtime.delivery.handle("process", replay.wire)).toEqual({
      status: "duplicate",
    });
    expect(effects).toBe(1);
    expect(calls).toBe(2);
    await h.runtime.close();
  });
  it("permits concurrent handler entry before a marker, making the business deduplication obligation explicit", async () => {
    const both = deferred(),
      resume = deferred();
    let entered = 0;
    const h = adapter({
      bind: () => ({
        process: {
          handle: async () => {
            if (++entered === 2) both.resolve();
            await resume.promise;
          },
        },
        observe: { handle: () => {} },
      }),
    });
    const attempts = [
      h.runtime.delivery.handle("process", h.original),
      h.runtime.delivery.handle("process", h.original),
    ];
    await both.promise;
    expect(entered).toBe(2);
    resume.resolve();
    await Promise.all(attempts);
    await h.runtime.close();
  });
  it("rejects unknown marker outcomes without a business effect", async () => {
    const handle = vi.fn();
    const h = adapter({
      bind: () => ({ process: { handle }, observe: { handle } }),
      wrap: (ports) => ({
        ...ports,
        markers: { ...ports.markers, check: async () => "unknown" as "available" },
      }),
    });
    await expect(h.runtime.delivery.handle("process", h.original)).rejects.toMatchObject({
      code: "resource.invalid_state",
    });
    expect(handle).not.toHaveBeenCalled();
    await h.runtime.close();
  });
  it("validates stored auxiliary ownership metadata before exposing a typed value", async () => {
    const h = adapter();
    await h.runtime.dispatch(
      {
        resourceType: "document",
        resourceId: "doc_1",
        commandName: "create",
        input: { title: "Draft" },
        idempotencyKey: "key",
        requestContext: {},
      },
      workflowAuth(),
    );
    const key = memoryPhysicalKey(workflowRecordKeys.record("receipt", "doc_1#1")),
      row = h.memory().records.get(key)!;
    h.memory().records.set(key, {
      ...row,
      owner: { ...row.owner, tenantId: "tenant" },
    } as typeof row);
    await expect(h.runtime.records.get(workflowReceipt, "doc_1#1")).rejects.toMatchObject({
      code: "resource.invalid_state",
    });
    await h.runtime.close();
  });
  it("rejects incomplete/asynchronous storage factories before consumer binding", () => {
    const bind = vi.fn(() => ({ process: { handle: () => {} } })),
      definition = defineWorkflow(publicWorkflowInput());
    expect(() =>
      createWorkflowRuntime(definition, () => ({}) as WorkflowStorage, { bind }),
    ).toThrow(/storage/);
    expect(() =>
      createWorkflowRuntime(
        definition,
        (async () => {
          throw new Error("observed factory rejection");
        }) as unknown as () => WorkflowStorage,
        { bind },
      ),
    ).toThrow(/synchronous/);
    expect(bind).not.toHaveBeenCalled();
  });
  it("preserves private invocation guards through the complete public composition", async () => {
    let services!: WorkflowServices;
    const h = adapter({
      bind: (value) => {
        services = value;
        return { process: { handle: () => {} }, observe: { handle: () => {} } };
      },
    });
    expect(Object.keys(services.repository)).toEqual(["getState"]);
    await expect(services.repository.getState("foreign", "id")).rejects.toMatchObject({
      code: "resource.not_found",
    });
    await h.runtime.close();
  });
  it("roundtrips frozen canonical legacy fact and replay bytes with declared schemas", async () => {
    const golden = JSON.parse(
      readFileSync(
        new URL(
          "../../../docs/iterations/003-framework-leverage/leverage/compatibility.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const original = golden.failure.record.original as JawStackEvent<Record<string, unknown>>;
    const payloadSchema = z.strictObject(
      Object.fromEntries(Object.keys(original.payload).map((key) => [key, z.unknown()])),
    );
    const resource = defineResource({
      name: original.resourceType,
      title: "Fixture",
      state: defineState({ title: field.string() }),
      commands: {
        create: defineCommand({
          title: "Create",
          create: true,
          roles: ["operator"],
          input: z.strictObject({}),
          emits: [{ eventType: original.eventType, schemaVersion: 1 }],
          decide: () => ({
            nextState: { title: "Fixture" },
            activity: [],
            events: [
              { eventType: original.eventType, schemaVersion: 1, payload: original.payload },
            ],
            response: {},
          }),
        }),
      },
      workers: [
        defineWorker({
          name: golden.failure.record.consumer as string,
          eventTypes: [original.eventType],
        }),
      ],
    });
    const definition = defineWorkflow({
      name: "fixture",
      source: original.source,
      resources: [resource],
      commands: { idempotencyTtlSeconds: 604800 },
      events: [
        {
          eventType: original.eventType,
          schemaVersion: 1,
          schema: payloadSchema,
          validateIdentity: (event) => event.resourceId === event.payload.contentId,
        },
      ],
      consumers: { [golden.failure.record.consumer as string]: { recovery: "replay" } },
      operations: {
        resourceType: original.resourceType,
        projection: `${original.resourceType}.failures`,
      },
    });
    let storage!: WorkflowStorage;
    const runtime = createWorkflowRuntime(
      definition,
      (spec) => {
        const memory = createMemoryWorkflowPersistence({ planner: spec.planner });
        const repository = new InMemoryRepository(memory.store);
        storage = {
          command: memory.factory,
          repository,
          queries: repository,
          records: { get: async () => undefined },
          failures: createMemoryWorkflowFailureStore({
            persistence: memory,
            protocol: spec.protocol,
          }),
          markers: createMemoryWorkflowMarkers(10, 10),
        };
        return storage;
      },
      { bind: () => ({ [golden.failure.record.consumer as string]: { handle: () => {} } }) },
    );
    expect(JSON.stringify(runtime.events.parse(original))).toBe(golden.wireJson);
    expect(JSON.stringify(runtime.events.parse(JSON.parse(golden.replayJson)))).toBe(
      golden.replayJson,
    );
    expect(storage).toBeDefined();
    await runtime.close();
  });
});
