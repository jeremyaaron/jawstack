import { expect, it, vi } from "vitest";

it("imports and constructs the Dynamo workflow without clients, network or timers", async () => {
  vi.resetModules();
  const fetch = vi.spyOn(globalThis, "fetch"),
    timers = vi.spyOn(globalThis, "setTimeout");
  try {
    const sdk = await import("@aws-sdk/client-dynamodb");
    const send = vi.spyOn(sdk.DynamoDBClient.prototype, "send");
    const borrowedSend = vi.fn(async () => {
      throw new Error("Unexpected startup I/O.");
    });
    const { fixture } = await import("./support/workflow");
    const h = fixture("dynamo", { client: { send: borrowedSend } });
    expect(send).not.toHaveBeenCalled();
    expect(borrowedSend).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(timers).not.toHaveBeenCalled();
    await h.runtime.close();
  } finally {
    vi.restoreAllMocks();
  }
});

it("keeps the intentional local subpath isolated and import-only without network/timers", async () => {
  vi.resetModules();
  const fetch = vi.spyOn(globalThis, "fetch"),
    timers = vi.spyOn(globalThis, "setTimeout");
  try {
    const sdk = await import("@aws-sdk/client-dynamodb");
    const send = vi.spyOn(sdk.DynamoDBClient.prototype, "send");
    const api = await import("@jawstack/aws-runtime/local");
    const root = await import("../src/index");
    expect(typeof api.parseLocalWorkflowBindings).toBe("function");
    expect(typeof api.createLocalWorkflow).toBe("function");
    expect(root).not.toHaveProperty("createLocalWorkflow");
    expect(send).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(timers).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});
