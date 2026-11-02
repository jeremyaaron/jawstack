import { describe, expect, it } from "vitest";
import { createWorkflowStorageSpec } from "@jawstack/core";
import { createContentStorageSpec, createContentWorkflow } from "../../src/application/workflow";
import { createContentDispatch } from "../../src/application/dispatch";
import { renderNotification } from "../../src/application/notifications";
import { parseContentEvent } from "../../src/shared/events";
import { fixtureAuth } from "../../src/shared/identities";
import { editorialHarness } from "../support/editorial";

describe("Content command migration", () => {
  it("declares records, facts and consumer policy without constructing a second delivery runtime", () => {
    const workflow = createContentWorkflow("content-operations.command-test");
    const spec = createWorkflowStorageSpec(workflow);
    expect(spec.manifest.source).toBe("content-operations.command-test");
    expect(spec.manifest.resources).toEqual(["asset", "contentItem", "reviewTask"]);
    expect(spec.manifest.records).toEqual(["commandReceipt", "publicationAttempt"]);
    expect(spec.manifest.commands).toEqual({ idempotencyTtlSeconds: 604800, maxActions: 60 });
    expect(
      spec.manifest.consumers.filter((c) => c.recovery === "application").map((c) => c.name),
    ).toEqual(["publishContent"]);
    expect(spec).not.toHaveProperty("delivery");
    expect(spec).not.toHaveProperty("start");
  });

  it("retains concurrent domain notification projections and backing-map identity during a shared command commit", async () => {
    const h = editorialHarness();
    const id = await h.create("review");
    const memory = h.app.persistence;
    const projections = memory.store.projections;
    const resources = memory.store.resources;
    const wire = memory.store.outbox.find((e) => e.eventType === "contentItem.reviewRequested")!;
    const event = parseContentEvent(wire);
    const spec = createContentStorageSpec();
    expect(() => spec.protocol.wire(wire)).not.toThrow();
    expect(() =>
      spec.protocol.wire({ ...wire, payload: { ...(wire.payload as object), status: "approved" } }),
    ).toThrow();
    let resume!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const dispatch = createContentDispatch({
      clock: h.clock.now,
      persistence: (scope, now) => {
        const scoped = memory.factory(scope, now);
        return {
          ...scoped,
          unitOfWork: {
            commit: async (input) => {
              reached();
              await gate;
              await scoped.unitOfWork.commit(input);
            },
          },
        };
      },
    });
    const pending = dispatch(
      {
        resourceType: "contentItem",
        resourceId: id,
        commandName: "archive",
        input: { expectedVersion: 2 },
        idempotencyKey: "coexisting-domain-write",
        requestContext: {},
      },
      fixtureAuth("editor_1"),
    );
    try {
      await waiting;
      const delivery = await h.app.notifications.deliver(renderNotification(event, h.clock.now()));
      resume();
      expect(await pending).toMatchObject({ ok: true });
      expect(memory.store.projections).toBe(projections);
      expect(memory.store.resources).toBe(resources);
      expect(await h.app.notifications.get(delivery.deliveryId)).toEqual(delivery);
      expect((await h.app.notifications.query()).items).toHaveLength(1);
      expect(memory.records.size).toBe(3);
      expect(memory.failures.size).toBe(0);
    } finally {
      resume();
      await pending;
    }
  });
});
