import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  inventorySchema,
  calculate,
  serializeResult,
  inputDigest,
  readReport,
  bytes,
  workerIdentity,
} from "../src/domain";
import { createMemoryReport, fixtureAuth } from "../src/workflow";
const id = "20000000-0000-4000-8000-000000000001",
  at = "2026-11-03T12:00:00.000Z";
const inventory = {
  items: [
    { itemId: "b", label: " Café ", quantity: 0 },
    { itemId: "A", label: "Stock", quantity: 7 },
  ],
};
export async function request(
  workflow = createMemoryReport(),
  actor = "requester_1",
  key = randomUUID(),
) {
  const response = await workflow.dispatch(
    {
      resourceType: "reportRun",
      commandName: "request",
      input: inventory,
      idempotencyKey: key,
      requestContext: {},
    },
    fixtureAuth(actor),
  );
  if (!response.ok) throw new Error(JSON.stringify(response));
  return { workflow, response, id: (response.data as { reportId: string }).reportId, key };
}
describe("canonical inventory and report", () => {
  it("normalizes NFC/trim/order and exports exact bytes with one LF", () => {
    const input = inventorySchema.parse(inventory);
    const equivalent = inventorySchema.parse({
      items: [...inventory.items].reverse().map((item) => ({
        ...item,
        label: item.label.trim().normalize("NFD"),
      })),
    });
    expect(input).toEqual(equivalent);
    expect(inputDigest(input)).toBe(inputDigest(equivalent));
    const result = serializeResult(calculate(id, at, input));
    expect(result.bytes.toString()).toBe(
      '{"version":1,"reportId":"20000000-0000-4000-8000-000000000001","requestedAt":"2026-11-03T12:00:00.000Z","items":[{"itemId":"A","label":"Stock","quantity":7},{"itemId":"b","label":"Café","quantity":0}],"summary":{"itemCount":2,"totalQuantity":7,"zeroStockCount":1}}\n',
    );
    expect(result.digest).toBe("f6ba848c7a895111497e6ff401696b0d587ac452617b2a7de4b089e126a6b44a");
    expect(result.bytes.length).toBeLessThanOrEqual(32768);
    expect(serializeResult(result.result).bytes).toEqual(result.bytes);
  });
  it.each([
    {},
    { items: [] },
    {
      items: Array.from({ length: 101 }, (_, i) => ({
        itemId: String(i),
        label: "X",
        quantity: 0,
      })),
    },
    { items: [{ itemId: "x", label: "ok", quantity: -1 }] },
    { items: [{ itemId: "x", label: "ok", quantity: 1.5 }] },
    { items: [{ itemId: "x", label: "ok", quantity: "1" }] },
    { items: [{ itemId: "x", label: "ok", quantity: 1000001 }] },
    { items: [{ itemId: "x", label: "ok", quantity: Infinity }] },
    { items: [{ itemId: "x", label: "ok", quantity: NaN }] },
    { items: [{ itemId: "x", label: "\ud800", quantity: 0 }] },
    { items: [{ itemId: "x", label: "bad\n", quantity: 0 }] },
    { items: [{ itemId: "x", label: "\u0085", quantity: 0 }] },
    { items: [{ itemId: "x", label: " ", quantity: 0 }] },
    { items: [{ itemId: "x", label: "é".repeat(81), quantity: 0 }] },
    { items: [{ itemId: "x/y", label: "X", quantity: 0 }] },
    { items: [{ itemId: "x", label: "X", quantity: 0, extra: true }] },
    {
      items: [
        { itemId: "x", label: "X", quantity: 0 },
        { itemId: "x", label: "Y", quantity: 1 },
      ],
    },
    { items: inventory.items, reportId: id },
    {
      items: Array.from({ length: 100 }, (_, i) => ({
        itemId: "id" + i,
        label: "x".repeat(160),
        quantity: 0,
      })),
    },
  ])("rejects invalid, coerced, duplicate, oversized or unsafe inventory %#", (value) => {
    expect(inventorySchema.safeParse(value).success).toBe(false);
  });
  it("accepts case-sensitive IDs, supplementary Unicode and safe aggregates", () => {
    const input = inventorySchema.parse({
      items: [
        { itemId: "a", label: "🌍".repeat(40), quantity: 1_000_000 },
        { itemId: "A", label: 'quote " and backslash \\', quantity: -0 },
      ],
    });
    expect(input.items.map((i) => i.itemId)).toEqual(["A", "a"]);
    expect(Object.is(input.items[0]!.quantity, -0)).toBe(false);
    expect(calculate(id, at, input).summary.totalQuantity).toBe(1_000_000);
  });
});
describe("report authority and shared runtime", () => {
  it("recognizes newly collected completed authority without reopening a report", async () => {
    const h = await request();
    try {
      await h.workflow.drainUntilIdle();
      const before = await h.workflow.repository.getState("reportRun", h.id);
      await h.workflow.delivery.collect("buildInventory", h.workflow.store.outbox[0]!);
      const page = await h.workflow.operations.inspect(fixtureAuth("operator_1"));
      if (!("items" in page)) throw new Error();
      expect(page.items[0]).toMatchObject({ status: "resolved", resolution: "succeeded" });
      expect(await h.workflow.repository.getState("reportRun", h.id)).toEqual(before);
    } finally {
      await h.workflow.close();
    }
  });
  it("rejects a validly hashed result for a different inventory before committing completion", async () => {
    const h = await request();
    try {
      const row = readReport(await h.workflow.repository.getState("reportRun", h.id), h.id);
      const other = serializeResult(
        calculate(
          h.id,
          row.state.requestedAt,
          inventorySchema.parse({
            items: [{ itemId: "forged", label: "Wrong inventory", quantity: 99 }],
          }),
        ),
      );
      const result = await h.workflow.dispatch(
        {
          resourceType: "reportRun",
          resourceId: h.id,
          commandName: "complete",
          input: {
            expectedVersion: 1,
            reportId: h.id,
            requestedAt: row.state.requestedAt,
            inputDigest: row.state.inputDigest,
            result: other.result,
            resultDigest: other.digest,
          },
          idempotencyKey: "invalid-completion",
          requestContext: {},
        },
        workerIdentity,
      );
      expect(result).toMatchObject({ ok: false, error: { code: "command.rejected" } });
      expect(await h.workflow.repository.getState("reportRun", h.id)).toEqual(row);
      expect(h.workflow.store.outbox).toHaveLength(1);
    } finally {
      await h.workflow.close();
    }
  });
  it("pins equivalent request responses and rejects conflicting keys across completion", async () => {
    const workflow = createMemoryReport({ clock: () => new Date(at) }),
      h = await request(workflow);
    try {
      await workflow.drainUntilIdle();
      const replay = await workflow.dispatch(
        {
          resourceType: "reportRun",
          commandName: "request",
          input: { items: [...inventory.items].reverse() },
          idempotencyKey: h.key,
          requestContext: {},
        },
        fixtureAuth("requester_1"),
      );
      expect(replay).toEqual(h.response);
      expect(
        readReport(await workflow.repository.getState("reportRun", h.id), h.id).state.status,
      ).toBe("completed");
      const conflict = await workflow.dispatch(
        {
          resourceType: "reportRun",
          commandName: "request",
          input: { items: [{ itemId: "other", label: "Changed", quantity: 1 }] },
          idempotencyKey: h.key,
          requestContext: {},
        },
        fixtureAuth("requester_1"),
      );
      expect(conflict).toMatchObject({ ok: false, error: { code: "idempotency.conflict" } });
    } finally {
      await workflow.close();
    }
  });
  it("converges concurrent deliveries, lost acknowledgement and transport/idempotency expiry", async () => {
    let time = Date.parse(at),
      interrupt = true;
    const workflow = createMemoryReport({
        clock: () => new Date(time),
        hooks: {
          afterComplete: () => {
            if (interrupt) {
              interrupt = false;
              throw new Error("lost ack");
            }
          },
        },
      }),
      h = await request(workflow);
    try {
      const original = workflow.store.outbox[0]!;
      expect(await workflow.drain()).toMatchObject({ retried: 1 });
      const first = readReport(await workflow.repository.getState("reportRun", h.id), h.id);
      time += 1000;
      await workflow.drainUntilIdle();
      time += 8 * 86400000;
      await Promise.all(
        Array.from({ length: 6 }, () => workflow.delivery.handle("buildInventory", original)),
      );
      const last = readReport(await workflow.repository.getState("reportRun", h.id), h.id);
      expect(last).toEqual(first);
      expect(last.version).toBe(2);
      expect(
        workflow.store.outbox.filter((e) => e.eventType === "reportRun.completed"),
      ).toHaveLength(1);
      expect(workflow.store.activity.filter((a) => a.activityType === "completed")).toHaveLength(1);
      expect(bytes(last.state)).toEqual(bytes(first.state));
    } finally {
      await workflow.close();
    }
  });
  it("collects/replays through public operations and defers to completed authority", async () => {
    let time = Date.parse(at),
      unavailable = true;
    const workflow = createMemoryReport({
        clock: () => new Date(time),
        hooks: {
          before: () => {
            if (unavailable) throw new Error("private provider details");
          },
        },
      }),
      h = await request(workflow);
    try {
      await workflow.drain();
      time += 1000;
      await workflow.drain();
      time += 2000;
      await workflow.drain();
      const page = await workflow.operations.inspect(fixtureAuth("operator_1"));
      if (!("items" in page)) throw new Error();
      const failed = page.items[0]!;
      expect(failed.status).toBe("failed");
      await expect(workflow.operations.inspect(fixtureAuth("requester_1"))).rejects.toMatchObject({
        code: "auth.forbidden",
      });
      expect(JSON.stringify(page)).not.toContain("private provider");
      unavailable = false;
      const key = randomUUID();
      await workflow.operations.replay(failed.id, fixtureAuth("operator_1"), key);
      await workflow.drainUntilIdle();
      expect(
        readReport(await workflow.repository.getState("reportRun", h.id), h.id).state.status,
      ).toBe("completed");
      await expect(
        workflow.operations.replay(failed.id, fixtureAuth("operator_1"), randomUUID()),
      ).rejects.toMatchObject({ code: "command.rejected" });
      await workflow.delivery.collect("buildInventory", workflow.store.outbox[0]!);
      expect(
        await workflow.operations.inspect(fixtureAuth("operator_1"), { id: failed.id }),
      ).toMatchObject({ status: "resolved" });
    } finally {
      await workflow.close();
    }
  });
  it("denies completion identities and rejects tampered stored results", async () => {
    const h = await request();
    try {
      const denied = await h.workflow.dispatch(
        {
          resourceType: "reportRun",
          resourceId: h.id,
          commandName: "complete",
          input: {},
          idempotencyKey: "forbidden",
          requestContext: {},
        },
        fixtureAuth("operator_1"),
      );
      expect(denied).toMatchObject({ ok: false, error: { code: "auth.forbidden" } });
      await h.workflow.drainUntilIdle();
      const row = (await h.workflow.repository.getState("reportRun", h.id))!;
      expect(() =>
        readReport(
          { ...row, state: { ...(row.state as object), resultDigest: "0".repeat(64) } },
          h.id,
        ),
      ).toThrow();
    } finally {
      await h.workflow.close();
    }
  });
});
