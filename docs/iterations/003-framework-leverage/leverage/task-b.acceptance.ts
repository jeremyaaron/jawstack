import { describe, expect, it } from "vitest";
import { createPublicationHarness } from "leverage:candidate";
import { fixture, type PublicationHarness } from "./contracts";

async function oneReceipt(h: PublicationHarness) {
  const event = h.original;
  expect(await h.receipts()).toEqual([
    {
      contentId: event.resourceId,
      publicationId: event.payload.publicationId,
      generation: event.payload.generation,
      sourceEventId: event.eventId,
      correlationId: event.correlationId,
    },
  ]);
  expect(await h.receiptEffects()).toEqual({
    resources: 1,
    versions: [1],
    activity: 1,
    completionFacts: 1,
  });
}
for (const backend of ["memory", "dynamo"] as const) {
  describe(`publication receipt: ${backend}`, () => {
    it("retries a transient fault and deduplicates after marker loss", async () => {
      const h = await createPublicationHarness(backend, fixture);
      try {
        expect(h.original.eventType).toBe("contentItem.published");
        h.setFault("beforeBusiness");
        await expect(h.deliver(h.original)).rejects.toThrow();
        expect(await h.receipts()).toEqual([]);
        h.setFault(null);
        await h.deliver(h.original);
        await h.clearMarkers();
        await h.deliver(h.original);
        await oneReceipt(h);
      } finally {
        await h.close();
      }
    });
    it("resumes interrupted collection, authorizes targeted replay and survives a lost success acknowledgement", async () => {
      const h = await createPublicationHarness(backend, fixture);
      try {
        h.setFault("beforeBusiness");
        for (let attempt = 0; attempt < 3; attempt++)
          await expect(h.deliver(h.original)).rejects.toThrow();
        h.setFault("afterRecord");
        await expect(h.collect(h.original)).rejects.toThrow();
        expect(await h.inspect("editor_1")).toMatchObject({ status: "reconciling", generation: 0 });
        h.setFault(null);
        await h.collect(h.original);
        expect(await h.inspect("editor_1")).toMatchObject({ status: "failed", generation: 0 });
        await expect(h.inspect("author_1")).rejects.toMatchObject({ code: "auth.forbidden" });
        await expect(h.replay("author_1", fixture.recoveryRequestId)).rejects.toMatchObject({
          code: "auth.forbidden",
        });
        const replay = await h.replay("editor_1", fixture.recoveryRequestId);
        expect(await h.replay("editor_1", fixture.recoveryRequestId)).toEqual(replay);
        expect(await h.inspect("editor_1")).toMatchObject({
          status: "replayQueued",
          generation: 1,
          recoveries: [expect.anything()],
        });
        expect(replay.eventId).not.toBe(h.original.eventId);
        expect(replay.causationId).toBe(h.original.eventId);
        expect(replay.actor).toEqual(h.original.actor);
        expect(replay.correlationId).toBe(h.original.correlationId);
        const { delivery, ...payload } = replay.payload;
        expect(payload).toEqual(h.original.payload);
        expect(delivery).toMatchObject({
          originalEventId: h.original.eventId,
          generation: 1,
          consumer: fixture.consumer,
          failureId: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        h.setFault("afterBusiness");
        await expect(h.deliver(replay)).rejects.toThrow();
        await oneReceipt(h);
        h.setFault(null);
        await h.clearMarkers();
        await h.deliver(replay);
        await h.deliver(h.original);
        await oneReceipt(h);
        expect(await h.inspect("editor_1")).toMatchObject({
          status: "resolved",
          generation: 1,
          recoveries: [expect.anything()],
        });
        await expect(h.replay("editor_1", fixture.secondRecoveryRequestId)).rejects.toThrow();
        await expect(
          h.deliver({ ...replay, eventId: fixture.secondRecoveryRequestId }),
        ).rejects.toThrow();
      } finally {
        await h.close();
      }
    });
  });
}
