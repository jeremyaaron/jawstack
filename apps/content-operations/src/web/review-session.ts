import { signal } from "@angular/core";
import { FormControl } from "@angular/forms";
import { JawStackApiError } from "@jawstack/angular";
import { reviewDecisionInput } from "../shared/contracts";
import type { ReviewView } from "../shared/review-views";
import type { FixtureId } from "../shared/identities";
import type { ContentOperationsClient, ContentResource } from "./client";
import { EditorialAction } from "./editorial-action";

export class ReviewSession {
  readonly review = signal<ReviewView | undefined>(undefined);
  readonly authority = signal<ContentResource | undefined>(undefined);
  readonly loading = signal(false);
  readonly error = signal("");
  readonly validation = signal("");
  readonly syncing = signal(false);
  readonly materialized = signal(false);
  readonly note = new FormControl("", { nonNullable: true });
  readonly action: EditorialAction;
  private sequence = 0;
  private destroyed = false;
  private readonly noteChanges = this.note.valueChanges.subscribe((value) => {
    if (this.validation() && reviewDecisionInput.shape.note.safeParse(value).success)
      this.validation.set("");
  });
  private request?: AbortController;
  constructor(
    private readonly client: ContentOperationsClient,
    private readonly fixture: () => FixtureId,
  ) {
    this.action = new EditorialAction(client, fixture);
  }
  destroy() {
    this.destroyed = true;
    this.noteChanges.unsubscribe();
    this.sequence++;
    this.request?.abort();
  }
  current() {
    const row = this.authority();
    const review = this.review();
    return (
      !!row &&
      !!review &&
      row.state.review?.reviewId === review.reviewId &&
      row.state.revisionId === review.submitted.revisionId
    );
  }
  canDecide() {
    const row = this.authority();
    const review = this.review();
    return (
      this.fixture().startsWith("editor") &&
      !this.loading() &&
      !this.error() &&
      this.current() &&
      row?.state.status === "inReview" &&
      row.state.review?.status === "pending" &&
      review?.status === "pending" &&
      review.sourceVersion <= row.version
    );
  }
  private adopt(model: ReviewView | undefined, authority: ContentResource) {
    const current = authority.state.review;
    const known = this.review();
    const id = model?.reviewId ?? known?.reviewId ?? current?.reviewId;
    const snapshot =
      current && current.reviewId === id && (!model || current.sourceVersion >= model.sourceVersion)
        ? current
        : model;
    if (!snapshot) throw new Error("Review snapshot unavailable.");
    this.review.set(snapshot);
    this.materialized.set(!!model);
    this.syncing.set(
      !model ||
        model.sourceVersion < snapshot.sourceVersion ||
        (model.status === "pending" && current?.reviewId !== model.reviewId),
    );
  }
  async load(id: string, contentId?: string) {
    if (this.destroyed) return;
    const sequence = ++this.sequence;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.loading.set(true);
    this.error.set("");
    this.validation.set("");
    try {
      let model: ReviewView | undefined;
      try {
        model = (await this.client.getReview(id, request.signal)).state;
      } catch (error) {
        if (!(error instanceof JawStackApiError && error.status === 404)) throw error;
      }
      if (model && contentId && model.contentId !== contentId)
        throw new Error("Review locator mismatch.");
      const parentId = model?.contentId ?? contentId;
      if (!parentId) throw new Error("Review snapshot unavailable.");
      const authority = await this.client.getContent(parentId, request.signal);
      if (!model && authority.state.review?.reviewId !== id)
        throw new Error("Review snapshot unavailable.");
      if (sequence !== this.sequence) return;
      this.review.set(undefined);
      this.authority.set(authority);
      this.adopt(model, authority);
      this.action.reset();
    } catch {
      if (sequence === this.sequence && !request.signal.aborted)
        this.error.set("Review is unavailable or has not materialized yet.");
    } finally {
      if (sequence === this.sequence) this.loading.set(false);
    }
  }
  async sync(signal: AbortSignal) {
    const review = this.review();
    const authority = this.authority();
    const sequence = this.sequence;
    if (!review || !authority || !this.syncing()) return false;
    try {
      const model = (await this.client.getReview(review.reviewId, signal)).state;
      if (!signal.aborted && sequence === this.sequence) this.adopt(model, authority);
    } catch {
      /* Missing/unavailable read models remain pending, not fabricated successes. */
    }
    return sequence === this.sequence && this.syncing();
  }
  async decide(name: "approve" | "requestChanges") {
    const row = this.authority();
    const review = this.review();
    if (!row || !review || !this.canDecide()) return false;
    const parsed = reviewDecisionInput.safeParse({
      expectedVersion: row.version,
      reviewId: review.reviewId,
      revisionId: review.submitted.revisionId,
      note: this.note.value,
    });
    if (!parsed.success) {
      this.validation.set("A decision note of 1-2,000 characters is required.");
      return false;
    }
    this.validation.set("");
    if (!(await this.action.run(name, parsed.data, row.resourceId))) return false;
    this.note.reset("");
    await this.load(review.reviewId, row.resourceId);
    return true;
  }
}
