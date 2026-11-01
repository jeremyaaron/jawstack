import { CommonModule } from "@angular/common";
import {
  Component,
  ChangeDetectorRef,
  DestroyRef,
  HostListener,
  effect,
  inject,
} from "@angular/core";
import { FormGroup, ReactiveFormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterLink, type CanDeactivateFn } from "@angular/router";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { JsErrorPanelComponent, JsStatusBadgeComponent } from "@jawstack/angular";
import {
  LucideArrowLeft,
  LucideCheck,
  LucideMessageSquare,
  LucideRefreshCw,
  LucideTrash2,
} from "@lucide/angular";
import { idSchema } from "../shared/validation";
import { Workspace } from "./workspace";
import { ReviewSession } from "./review-session";
import { VisibilityPoll } from "./visibility-poll";
import { ActivityComponent } from "./activity";

@Component({
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterLink,
    JsErrorPanelComponent,
    JsStatusBadgeComponent,
    LucideArrowLeft,
    LucideCheck,
    LucideMessageSquare,
    LucideRefreshCw,
    LucideTrash2,
    ActivityComponent,
  ],
  template: `
    <a class="back-link" aria-label="Back to reviews" [routerLink]="backLink()"
      ><svg lucideArrowLeft aria-hidden="true"></svg>Reviews</a
    >
    @if (session.loading()) {
      <div class="empty-state" role="status">
        <span class="spinner"></span>
        <h2>Loading review</h2>
      </div>
    } @else if (session.error()) {
      <js-error-panel title="Review unavailable" [message]="session.error()" /><button
        class="button"
        (click)="refresh()"
      >
        Try again
      </button>
    } @else if (session.review(); as review) {
      <section class="page-heading">
        <div>
          <p class="eyebrow">SUBMITTED SNAPSHOT</p>
          <h1>{{ review.submitted.title }}</h1>
        </div>
        <js-status-badge [value]="review.status" />
      </section>
      @if (session.syncing()) {
        <p class="sync-state" role="status">
          Review read model {{ session.materialized() ? "synchronizing" : "pending" }}
        </p>
      }
      @if (!session.current()) {
        <p class="sync-state">Historical review · not the current submitted revision</p>
      }
      @if (session.action.error()) {
        <js-error-panel title="Decision not recorded" [message]="session.action.error()" />
      }
      <div class="review-layout">
        <section class="submitted-snapshot" aria-label="Submitted snapshot">
          <h2>Submitted content</h2>
          <pre>{{ review.submitted.body }}</pre>
          @if (review.submitted.attachments.length) {
            <h3>Submitted attachments</h3>
            <ul class="snapshot-assets">
              @for (asset of review.submitted.attachments; track asset.assetId) {
                <li>
                  {{ asset.filename }}<span>{{ asset.mediaType }} · {{ asset.size }} bytes</span>
                </li>
              }
            </ul>
          }
        </section>
        <aside class="item-properties">
          <h2>Review details</h2>
          <dl>
            <dt>Author</dt>
            <dd>{{ review.submitted.authorId.replace("_", " ") }}</dd>
            <dt>Assigned</dt>
            <dd>{{ review.assignedEditorId.replace("_", " ") }}</dd>
            <dt>Submitted</dt>
            <dd>{{ review.submitted.submittedAt | date: "MMM d, HH:mm" : "UTC" }} UTC</dd>
            <dt>Due</dt>
            <dd>{{ review.dueAt | date: "MMM d, HH:mm" : "UTC" }} UTC</dd>
            <dt>Revision</dt>
            <dd class="identifier">{{ review.submitted.revisionId }}</dd>
            <dt>Source</dt>
            <dd>Version {{ review.sourceVersion }}</dd>
          </dl>
          <a class="button" [routerLink]="['/content', review.contentId]">Current content</a>
        </aside>
      </div>
      @if (review.decision) {
        <section class="review-section">
          <h2 id="recorded-decision" tabindex="-1">Recorded decision</h2>
          <blockquote class="decision-note">
            <p>{{ review.decision.note ?? "Review superseded" }}</p>
            <footer>
              {{ review.decision.actorId.replace("_", " ") }} ·
              {{ review.decision.at | date: "MMM d, HH:mm" }}
            </footer>
          </blockquote>
        </section>
      }
      @if (session.canDecide()) {
        <section class="review-section" aria-label="Review decision">
          <h2>Decision</h2>
          <form class="decision-form" [formGroup]="decisionForm" (ngSubmit)="decide('approve')">
            <label for="decision-note">Decision note</label
            ><textarea
              id="decision-note"
              formControlName="note"
              maxlength="2000"
              [readOnly]="session.action.pending()"
              [attr.aria-invalid]="session.validation() ? true : null"
              aria-describedby="decision-validation"
            ></textarea>
            @if (session.validation()) {
              <p id="decision-validation" class="validation" role="alert">
                {{ session.validation() }}
              </p>
            }
            <div class="actions">
              <button
                class="button"
                type="button"
                [disabled]="session.action.pending() || session.action.conflict()"
                (click)="decide('requestChanges')"
              >
                <svg lucideMessageSquare aria-hidden="true"></svg>Request changes</button
              ><button
                class="button primary"
                type="submit"
                [disabled]="session.action.pending() || session.action.conflict()"
              >
                <svg lucideCheck aria-hidden="true"></svg>Approve
              </button>
            </div>
          </form>
        </section>
      } @else if (review.status === "pending") {
        <p class="permission-state">
          {{
            workspace.fixture().startsWith("author")
              ? "Only editors can record review decisions."
              : "This review is no longer actionable on the loaded content version."
          }}
        </p>
      }
      @if (!session.canDecide() && session.note.value) {
        <section class="review-section decision-form" aria-label="Unrecorded note">
          <h2>Unrecorded note</h2>
          <label for="unrecorded-note">Unrecorded decision note</label
          ><textarea id="unrecorded-note" [formControl]="session.note" readonly></textarea>
          <div class="actions">
            <button class="button" (click)="session.note.reset('')">
              <svg lucideTrash2 aria-hidden="true"></svg>Discard note
            </button>
          </div>
        </section>
      }
      <div class="actions review-refresh">
        <button class="button" [disabled]="session.action.pending()" (click)="refresh()">
          <svg lucideRefreshCw aria-hidden="true"></svg>Refresh review
        </button>
      </div>
      <content-activity
        [resourceId]="review.contentId"
        [contentId]="review.contentId"
        [version]="session.authority()?.version ?? 0"
      />
    }
  `,
})
export class ReviewDetailComponent {
  readonly workspace = inject(Workspace);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly change = inject(ChangeDetectorRef);
  private readonly destroy = inject(DestroyRef);
  readonly session = new ReviewSession(this.workspace.client, () => this.workspace.fixture());
  readonly decisionForm = new FormGroup({ note: this.session.note });
  private readonly poll = new VisibilityPoll(document);
  private id = "";
  private contentId: string | undefined;
  private fixture = this.workspace.fixture();
  constructor() {
    this.workspace.canLeave = () => this.canLeave();
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      this.id = params.get("id") ?? "";
      const hint = this.route.snapshot.queryParamMap.get("contentId");
      this.contentId = hint ?? undefined;
      this.session.note.reset("");
      void this.load();
    });
    effect(() => {
      const fixture = this.workspace.fixture();
      if (fixture !== this.fixture) {
        this.fixture = fixture;
        this.session.note.reset("");
        void this.load();
      }
    });
    this.destroy.onDestroy(() => {
      this.poll.destroy();
      this.session.destroy();
      this.workspace.canLeave = () => true;
    });
  }
  backLink() {
    return this.router.parseUrl(this.workspace.reviewsUrl);
  }
  canLeave() {
    return (
      !this.session.action.pending() &&
      (!this.session.note.value || window.confirm("Discard unsaved decision note?"))
    );
  }
  @HostListener("window:beforeunload", ["$event"]) beforeUnload(event: BeforeUnloadEvent) {
    if (this.session.note.value || this.session.action.pending()) event.preventDefault();
  }
  async load() {
    this.poll.stop();
    if (
      !idSchema.safeParse(this.id).success ||
      (this.contentId && !idSchema.safeParse(this.contentId).success)
    ) {
      this.session.error.set("The review reference is invalid.");
      return;
    }
    await this.session.load(this.id, this.contentId);
    if (this.session.syncing() && !this.session.error())
      this.poll.start((signal) => this.session.sync(signal));
  }
  refresh() {
    if (!this.session.action.pending()) void this.load();
  }
  async decide(name: "approve" | "requestChanges") {
    this.poll.stop();
    if (await this.session.decide(name)) {
      if (this.session.syncing()) this.poll.start((signal) => this.session.sync(signal));
      if (!this.destroy.destroyed) {
        this.change.detectChanges();
        document.getElementById("recorded-decision")?.focus();
      }
    } else {
      if (this.session.validation()) document.getElementById("decision-note")?.focus();
      if (this.session.syncing()) this.poll.start((signal) => this.session.sync(signal));
    }
  }
}
export const reviewGuard: CanDeactivateFn<ReviewDetailComponent> = (component) =>
  component.canLeave();
