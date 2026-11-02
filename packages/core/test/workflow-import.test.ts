import { expect, it, vi } from "vitest";

it("imports and configures the supported workflow surface without application I/O or timers", async () => {
  vi.resetModules();
  const createServer = vi.fn(() => {
    throw new Error("Unexpected server construction.");
  });
  vi.doMock("node:http", () => ({ createServer }));
  const fetch = vi.spyOn(globalThis, "fetch");
  const timers = vi.spyOn(globalThis, "setTimeout");
  try {
    const api = await import("@jawstack/core"),
      { z } = await import("zod");
    const resource = api.defineResource({
      name: "sample",
      title: "Sample",
      state: api.defineState({ title: api.field.string() }),
      commands: {
        create: api.defineCommand({
          title: "Create",
          create: true,
          roles: ["operator"],
          input: z.object({ title: z.string() }),
          emits: [{ eventType: "sample.created", schemaVersion: 1 }],
          decide: ({ input, resourceId }) => ({
            nextState: input,
            activity: [],
            response: {},
            events: [
              { eventType: "sample.created", schemaVersion: 1, payload: { id: resourceId } },
            ],
          }),
        }),
      },
      workers: [api.defineWorker({ name: "consume", eventTypes: ["sample.created"] })],
    });
    const definition = api.defineWorkflow({
      name: "sample",
      source: "sample",
      resources: [resource],
      commands: { idempotencyTtlSeconds: 604800 },
      events: [
        {
          eventType: "sample.created",
          schemaVersion: 1,
          schema: z.object({ id: z.string() }),
          validateIdentity: (event) => event.payload.id === event.resourceId,
        },
      ],
      consumers: { consume: { recovery: "replay" } },
      operations: { resourceType: "sample", projection: "sample.failures" },
    });
    const bind = vi.fn(() => ({ consume: { handle: () => {} } }));
    const runtime = api.createMemoryWorkflow(definition, { bind });
    expect(bind).toHaveBeenCalledTimes(1);
    expect(createServer).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(timers).not.toHaveBeenCalled();
    await runtime.close();
  } finally {
    vi.restoreAllMocks();
    vi.doUnmock("node:http");
  }
});
