import { describe, expect, it } from "vitest";
import { createApprovalHarness } from "leverage:candidate";
import { fixture, type ApprovalHarness, type ApprovalReceipt } from "./contracts";

function receipt(h: ApprovalHarness): ApprovalReceipt {
  return {
    kind: "approvalReceipt",
    contentId: fixture.contentId,
    reviewId: h.context.reviewId,
    revisionId: h.context.revisionId,
    actor: "editor_1",
    approvedAt: fixture.instant,
    contentVersion: h.context.version + 1,
  };
}
for (const backend of ["memory", "dynamo"] as const) {
  describe(`approval receipt: ${backend}`, () => {
    it("commits one owned receipt with approval and replays the exact response", async () => {
      const h = await createApprovalHarness(backend, fixture);
      try {
        expect(h.context.version).toBe(2);
        const originalEffects = await h.effects();
        const results = await Promise.all(
          Array.from({ length: 4 }, () => h.approve("approve-equivalent")),
        );
        expect(results[0]).toMatchObject({ ok: true });
        for (const result of results) expect(result).toEqual(results[0]);
        expect(await h.receipts()).toEqual([receipt(h)]);
        expect(await h.current()).toMatchObject({
          version: 3,
          state: {
            status: "approved",
            approval: {
              reviewId: h.context.reviewId,
              revisionId: h.context.revisionId,
              approvedBy: "editor_1",
              approvedAt: fixture.instant,
            },
          },
        });
        expect(await h.effects()).toEqual({
          activity: originalEffects.activity + 1,
          outbox: originalEffects.outbox + 1,
          idempotency: originalEffects.idempotency + 1,
        });
        const before = await h.snapshot();
        for (const category of [
          "state",
          "activity",
          "outbox",
          "projections",
          "idempotency",
          "records",
        ])
          expect(before).toHaveProperty(category);
        expect(await h.approve("approve-equivalent")).toEqual(results[0]);
        expect(await h.snapshot()).toEqual(before);
      } finally {
        await h.close();
      }
    });
    it("a pre-existing create-only receipt rolls back every category", async () => {
      const h = await createApprovalHarness(backend, fixture);
      try {
        const collision = { ...receipt(h), approvedAt: "2026-10-31T12:00:00.000Z" };
        await h.seedReceipt(collision);
        const before = await h.snapshot();
        expect(await h.approve("approve-conflict")).toMatchObject({
          ok: false,
          error: { code: "resource.conflict" },
        });
        expect(await h.snapshot()).toEqual(before);
        expect(await h.receipts()).toEqual([collision]);
      } finally {
        await h.close();
      }
    });
  });
}
