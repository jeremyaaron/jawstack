// Test-only ports. Candidate adapters must delegate to real app services/stores.
export const fixture = Object.freeze({
  instant: "2026-11-01T12:00:00.000Z",
  contentId: "00000000-0000-4000-8000-000000000901",
  recoveryRequestId: "00000000-0000-4000-8000-000000000902",
  secondRecoveryRequestId: "00000000-0000-4000-8000-000000000903",
  consumer: "recordPublicationReceipt",
});
export type Backend = "memory" | "dynamo";
export type Result = { ok: boolean; error?: { code: string } };
export type Envelope = {
  eventId: string;
  eventType: string;
  resourceId: string;
  occurredAt: string;
  correlationId: string;
  causationId?: string;
  actor?: { subject: string; displayName?: string };
  payload: Record<string, unknown>;
};
export type Snapshot = {
  state: unknown;
  activity: unknown;
  outbox: unknown;
  projections: unknown;
  idempotency: unknown;
  records: unknown;
};
export type ApprovalReceipt = {
  kind: "approvalReceipt";
  contentId: string;
  reviewId: string;
  revisionId: string;
  actor: "editor_1";
  approvedAt: string;
  contentVersion: number;
};
export interface ApprovalHarness {
  context: { reviewId: string; revisionId: string; version: number };
  current(): Promise<{
    version: number;
    state: { status: string; approval: unknown };
  }>;
  effects(): Promise<{ activity: number; outbox: number; idempotency: number }>;
  approve(key: string): Promise<Result>;
  seedReceipt(value: ApprovalReceipt): Promise<void>;
  receipts(): Promise<ApprovalReceipt[]>;
  snapshot(): Promise<Snapshot>;
  close(): Promise<void>;
}
export type FailureView = {
  status: "reconciling" | "failed" | "replayQueued" | "resolved";
  generation: number;
  recoveries: unknown[];
};
export type PublicationReceipt = {
  contentId: string;
  publicationId: string;
  generation: number;
  sourceEventId: string;
  correlationId: string;
};
export interface PublicationHarness {
  // Create/publish through ordinary editorial commands; return the real committed fact.
  original: Envelope;
  setFault(point: "beforeBusiness" | "afterBusiness" | "afterRecord" | null): void;
  deliver(event: Envelope): Promise<void>;
  collect(event: Envelope): Promise<void>;
  inspect(actor: "editor_1" | "author_1"): Promise<FailureView>;
  replay(actor: "editor_1" | "author_1", requestId: string): Promise<Envelope>;
  clearMarkers(): Promise<void>;
  receipts(): Promise<PublicationReceipt[]>;
  receiptEffects(): Promise<{
    resources: number;
    versions: number[];
    activity: number;
    completionFacts: number;
  }>;
  close(): Promise<void>;
}
