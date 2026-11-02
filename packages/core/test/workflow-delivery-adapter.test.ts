import { describe, expect, it, vi } from "vitest";
import {
  createMemoryWorkflowFailureStore,
  createMemoryWorkflowMarkers,
  createMemoryWorkflowPersistence,
  createWorkflowDelivery,
  createWorkflowFailureService,
  createWorkflowPump,
  createWorkflowStorageSpec,
  defineWorkflow,
} from "@jawstack/core";
import { publicWorkflowInput, testInstant, workflowAuth } from "./support/public-workflow";

function fixture() {
  const definition = defineWorkflow(publicWorkflowInput());
  const spec = createWorkflowStorageSpec(definition);
  const persistence = createMemoryWorkflowPersistence({ planner: spec.planner });
  const store = createMemoryWorkflowFailureStore({ persistence, protocol: spec.protocol });
  const clock = () => new Date(testInstant);
  const failures = createWorkflowFailureService({
    protocol: spec.protocol,
    store,
    clock,
    authorizeOperations: () => true,
  });
  const handle = vi.fn(async () => {});
  const bindings = new Map([["process", { handle }]]);
  const markers = createMemoryWorkflowMarkers(1, 1);
  const options = {
    definition,
    failures,
    markers,
    bindings,
    clock,
    signal: new AbortController().signal,
    run: async <T>(work: () => T | Promise<T>) => work(),
  };
  const wire = {
    envelopeVersion: 1 as const,
    schemaVersion: 1,
    eventId: "external",
    eventType: "document.created",
    source: "documents",
    resourceType: "document",
    resourceId: "doc_1",
    correlationId: "correlation",
    occurredAt: testInstant,
    payload: { docId: "doc_1", title: "Draft" },
  };
  return { spec, persistence, failures, store, handle, bindings, options, wire };
}
describe("public delivery adapter composition", () => {
  it("captures complete bindings before effects and uses the shared replay ledger", async () => {
    const f = fixture();
    const delivery = createWorkflowDelivery(f.options);
    f.bindings.clear();
    await f.failures.collect("process", f.wire);
    const page = await f.failures.inspect(workflowAuth());
    if (!("items" in page)) throw new Error("Expected a failure page.");
    await f.failures.replay(
      page.items[0]!.id,
      workflowAuth(),
      "00000000-0000-4000-8000-000000000001",
    );
    const replay = f.persistence.store.outbox[0]!;
    expect(await delivery.handle("process", replay)).toEqual({ status: "processed" });
    expect(f.handle).toHaveBeenCalledTimes(1);
    expect((await f.store.get(page.items[0]!.id))!.resolvedGeneration).toBe(1);
    expect(await delivery.handle("process", replay)).toEqual({ status: "duplicate" });
    expect(f.handle).toHaveBeenCalledTimes(1);
  });
  it("rejects incomplete bindings and unsafe marker capacities before invoking a handler", () => {
    const f = fixture();
    f.bindings.clear();
    expect(() => createWorkflowDelivery(f.options)).toThrow("Complete owned consumer bindings");
    for (const n of [0, -1, 10001, NaN, 1.5])
      expect(() => createMemoryWorkflowMarkers(n, 1)).toThrow();
    expect(f.handle).not.toHaveBeenCalled();
  });
  it("backpressures full markers without evicting prior delivery identity", async () => {
    const f = fixture();
    const delivery = createWorkflowDelivery(f.options);
    await delivery.handle("process", f.wire);
    expect(await delivery.handle("process", { ...f.wire, eventId: "next" })).toEqual({
      status: "deferred",
    });
    expect(await delivery.handle("process", f.wire)).toEqual({ status: "duplicate" });
    expect(f.handle).toHaveBeenCalledTimes(1);
    expect(() =>
      createWorkflowPump({
        outbox: () => [],
        parse: f.spec.parse,
        subscribers: () => ["process"],
        delivery,
        clock: f.options.clock,
        signal: f.options.signal,
        maxJobs: 0,
        markerCounts: () => ({ delivery: 1, collection: 0 }),
        run: f.options.run,
        check: () => {},
      }),
    ).toThrow();
  });
});
