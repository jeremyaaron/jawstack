import { CommonModule } from "@angular/common";
import { Component, DestroyRef, HostListener, effect, inject, signal } from "@angular/core";
import { FormControl, FormGroup, ReactiveFormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { JsErrorPanelComponent } from "@jawstack/angular";
import {
  LucideActivity,
  LucideBell,
  LucideTriangleAlert,
  LucideRefreshCw,
  LucideFilter,
  LucideArrowDown,
} from "@lucide/angular";
import { operationsQueryInput, type OperationsQuery } from "../shared/api";
import type {
  PublicationOperation,
  NotificationView,
  FailureSummary,
} from "../shared/operation-views";
import { fixtureIds } from "../shared/identities";
import type { ContentResource, OperationRow } from "./client";
import { Workspace } from "./workspace";
import { RecoveryComponent } from "./recovery";
import { VisibilityPoll } from "./visibility-poll";
import { publicationRecovery } from "../shared/publication-recovery";

const statuses = {
  attempts: ["claimed", "succeeded", "failed", "expired"],
  notifications: ["succeeded"],
  failures: ["reconciling", "replayQueued", "resolved", "failed"],
};
export const operationsScreenInput = operationsQueryInput.refine(
  (q) => !q.status || statuses[q.view].includes(q.status),
  "Status does not apply to this view.",
);

@Component({
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterLink,
    JsErrorPanelComponent,
    LucideActivity,
    LucideBell,
    LucideTriangleAlert,
    LucideRefreshCw,
    LucideFilter,
    LucideArrowDown,
    RecoveryComponent,
  ],
  template: `
    <section class="page-heading">
      <div>
        <p class="eyebrow">RUNTIME</p>
        <h1>Operations</h1>
      </div>
      <button
        type="button"
        class="icon-button"
        aria-label="Refresh operations"
        title="Refresh operations"
        [disabled]="loading() || busy()"
        (click)="load(false)"
      >
        <svg lucideRefreshCw aria-hidden="true"></svg>
      </button>
    </section>
    @if (!editor()) {
      <js-error-panel
        title="Editor access required"
        message="This fixture cannot read operations or initiate recovery."
      />
    } @else {
      <div class="operation-tabs" role="group" aria-label="Operations view">
        <button
          type="button"
          [attr.aria-pressed]="view() === 'attempts'"
          [disabled]="busy()"
          (click)="setView('attempts')"
        >
          <svg lucideActivity aria-hidden="true"></svg>Publication attempts
        </button>
        <button
          type="button"
          [attr.aria-pressed]="view() === 'notifications'"
          [disabled]="busy()"
          (click)="setView('notifications')"
        >
          <svg lucideBell aria-hidden="true"></svg>Notifications
        </button>
        <button
          type="button"
          [attr.aria-pressed]="view() === 'failures'"
          [disabled]="busy()"
          (click)="setView('failures')"
        >
          <svg lucideTriangleAlert aria-hidden="true"></svg>Failures
        </button>
      </div>
      <form class="operation-filters" [formGroup]="filters" (ngSubmit)="apply()">
        <fieldset [disabled]="busy()">
          <label
            >Content ID<input
              aria-label="Operation content ID"
              formControlName="contentId"
              autocomplete="off"
              maxlength="36"
          /></label>
          <label
            >Status<select aria-label="Operation status" formControlName="status">
              <option value="">All statuses</option>
              @for (status of statuses(); track status) {
                <option [value]="status">{{ status }}</option>
              }
            </select></label
          >
          @if (view() === "notifications") {
            <label
              >Recipient<select aria-label="Notification recipient" formControlName="recipientId">
                <option value="">All recipients</option>
                @for (id of fixtures; track id) {
                  <option [value]="id">{{ id.replace("_", " ") }}</option>
                }
              </select></label
            >
          }
          <button
            type="submit"
            class="icon-button"
            title="Apply operation filters"
            aria-label="Apply operation filters"
          >
            <svg lucideFilter aria-hidden="true"></svg>
          </button>
        </fieldset>
      </form>
      @if (error()) {
        <js-error-panel title="Operations unavailable" [message]="error()" />
      }
      @if (selected(); as row) {
        <section class="selected-publication" aria-label="Selected publication">
          <header class="section-heading">
            <h2>{{ row.state.title }}</h2>
            <a class="inline-link" [routerLink]="['/content', row.resourceId]">Current content</a>
          </header>
          @if (!row.state.publication) {
            <p class="muted">No publication requested</p>
          }
          <publication-recovery
            [row]="row"
            (changed)="authorityChanged($event)"
            (busy)="busy.set($event)"
          />
          <a
            class="inline-link"
            routerLink="/reviews"
            [queryParams]="{ contentId: row.resourceId, status: 'all' }"
            >Review history</a
          >
        </section>
      }
      <div class="results-heading">
        <span>{{ items().length }} operation{{ items().length === 1 ? "" : "s" }} loaded</span
        ><span role="status">{{
          loading() ? "Loading operations" : following() ? "Following pending records" : "Snapshot"
        }}</span>
      </div>
      @if (!loading() && !error() && !items().length) {
        <div class="empty-state">
          <h2>{{ cursor() ? "No matches on this page" : "No matching operations" }}</h2>
        </div>
      }
      <ol class="operation-list" aria-label="Operation records">
        @for (row of items(); track row.itemId) {
          <li class="operation-record" [attr.data-operation-id]="row.itemId">
            @if (attempt(row); as data) {
              <header class="operation-heading">
                <h2>Publication attempt · generation {{ data.attempt.generation }}</h2>
                <span class="operation-state" [attr.data-status]="data.attempt.status">{{
                  data.attempt.status
                }}</span>
              </header>
              <p class="muted">
                {{ data.attempt.claim.startedAt | date: "MMM d, yyyy, HH:mm:ss" : "UTC" }} UTC
              </p>
              <div class="operation-links">
                <a
                  class="inline-link"
                  routerLink="/operations"
                  [queryParams]="inspectParams(data.contentId)"
                  >Inspect publication</a
                ><a class="inline-link" [routerLink]="['/content', data.contentId]"
                  >Current content</a
                ><a
                  class="inline-link"
                  routerLink="/reviews"
                  [queryParams]="{ contentId: data.contentId, status: 'all' }"
                  >Review history</a
                >
              </div>
              <details>
                <summary>Trace details</summary>
                <dl class="operation-metadata">
                  <dt>Content</dt>
                  <dd>{{ data.contentId }}</dd>
                  <dt>Publication</dt>
                  <dd>{{ data.publicationId }}</dd>
                  <dt>Attempt</dt>
                  <dd>{{ data.attempt.claim.attemptId }}</dd>
                  <dt>Lease until</dt>
                  <dd>{{ data.attempt.claim.leaseUntil }}</dd>
                  <dt>Finished</dt>
                  <dd>{{ data.attempt.finishedAt ?? "Not recorded" }}</dd>
                  <dt>Failure code</dt>
                  <dd>{{ data.attempt.failureCode ?? "None recorded" }}</dd>
                  <dt>Correlation</dt>
                  <dd>{{ data.attempt.correlationId }}</dd>
                  <dt>Source event</dt>
                  <dd>{{ data.attempt.sourceEventId }}</dd>
                  <dt>Causation</dt>
                  <dd>{{ data.causationId }}</dd>
                  <dt>Transition event</dt>
                  <dd>{{ data.transitionEventId }}</dd>
                </dl>
              </details>
            }
            @if (notification(row); as data) {
              <header class="operation-heading">
                <h2>{{ data.subject }}</h2>
                <span class="operation-state" data-status="succeeded">{{ data.status }}</span>
              </header>
              <p>{{ data.message }}</p>
              <p class="muted">
                {{ data.recipientId.replace("_", " ") }} · {{ data.channel }} ·
                {{ data.deliveredAt | date: "MMM d, yyyy, HH:mm:ss" : "UTC" }} UTC
              </p>
              <div class="operation-links">
                <a class="inline-link" [routerLink]="['/content', data.contentId]"
                  >Current content</a
                >
                @if (data.reviewId) {
                  <a
                    class="inline-link"
                    [routerLink]="['/reviews', data.reviewId]"
                    [queryParams]="{ contentId: data.contentId }"
                    >Review snapshot</a
                  >
                }
              </div>
              <details>
                <summary>Trace details</summary>
                <dl class="operation-metadata">
                  <dt>Delivery</dt>
                  <dd>{{ data.deliveryId }}</dd>
                  <dt>Template</dt>
                  <dd>{{ data.template }}</dd>
                  <dt>Occurred</dt>
                  <dd>{{ data.occurredAt }}</dd>
                  <dt>Correlation</dt>
                  <dd>{{ data.correlationId }}</dd>
                  <dt>Source event</dt>
                  <dd>{{ data.sourceEventId }}</dd>
                  <dt>Transport event</dt>
                  <dd>{{ data.transportEventId }}</dd>
                  <dt>Causation</dt>
                  <dd>{{ data.causationId }}</dd>
                </dl>
              </details>
            }
            @if (failure(row); as data) {
              <header class="operation-heading">
                <h2>{{ data.consumer }}</h2>
                <span class="operation-state" [attr.data-status]="data.status">{{
                  data.status
                }}</span>
              </header>
              <p class="muted">
                {{ data.eventType }} ·
                {{ data.firstCollectedAt | date: "MMM d, yyyy, HH:mm:ss" : "UTC" }} UTC
              </p>
              <div class="operation-links">
                @if (data.resourceType === "contentItem") {
                  <a class="inline-link" [routerLink]="['/content', data.resourceId]"
                    >Current content</a
                  ><a
                    class="inline-link"
                    routerLink="/reviews"
                    [queryParams]="{ contentId: data.resourceId, status: 'all' }"
                    >Review history</a
                  >
                }
              </div>
              <details>
                <summary>Trace details</summary>
                <dl class="operation-metadata">
                  <dt>Failure</dt>
                  <dd>{{ data.id }}</dd>
                  <dt>Resource</dt>
                  <dd>{{ data.resourceType }} / {{ data.resourceId }}</dd>
                  <dt>Version</dt>
                  <dd>{{ data.version }}</dd>
                  <dt>Correlation</dt>
                  <dd>{{ data.correlationId }}</dd>
                  <dt>Original event</dt>
                  <dd>{{ data.originalEventId }}</dd>
                  <dt>Resolution</dt>
                  <dd>{{ data.resolution ?? "Pending collection" }}</dd>
                  <dt>Consumer replay</dt>
                  <dd>
                    {{
                      data.consumer === "publishContent"
                        ? "Not permitted"
                        : data.recoveries.length + " / 3"
                    }}
                  </dd>
                </dl>
                <h3>Collections</h3>
                <ul class="failure-history">
                  @for (collection of data.collections; track collection.generation) {
                    <li>
                      Generation {{ collection.generation }} · {{ collection.resolution
                      }}<time [dateTime]="collection.collectedAt">{{ collection.collectedAt }}</time
                      ><span>{{ collection.eventId }}</span>
                    </li>
                  }
                </ul>
                @if (data.recoveries.length) {
                  <h3>Recovery requests</h3>
                  <ul class="failure-history">
                    @for (recovery of data.recoveries; track recovery.generation) {
                      <li>
                        Generation {{ recovery.generation }} · {{ recovery.requestedBy
                        }}<time [dateTime]="recovery.requestedAt">{{ recovery.requestedAt }}</time
                        ><span>{{ recovery.eventId }}</span
                        ><span>{{ recovery.requestId }}</span>
                      </li>
                    }
                  </ul>
                }
              </details>
            }
          </li>
        }
      </ol>
      @if (cursor()) {
        <div class="pagination">
          <button
            class="button"
            type="button"
            [disabled]="loading() || busy()"
            (click)="load(true)"
          >
            <svg lucideArrowDown aria-hidden="true"></svg>Load more operations
          </button>
        </div>
      }
    }
  `,
})
export class OperationsComponent {
  readonly workspace = inject(Workspace);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  private readonly poll = new VisibilityPoll(document);
  readonly fixtures = fixtureIds;
  readonly filters = new FormGroup({
    contentId: new FormControl("", { nonNullable: true }),
    recipientId: new FormControl("", { nonNullable: true }),
    status: new FormControl("", { nonNullable: true }),
  });
  readonly items = signal<OperationRow[]>([]);
  readonly selected = signal<ContentResource | undefined>(undefined);
  readonly busy = signal(false);
  readonly loading = signal(false);
  readonly following = signal(false);
  readonly error = signal("");
  readonly cursor = signal<string | undefined>(undefined);
  readonly view = signal<"attempts" | "notifications" | "failures">("attempts");
  private query: OperationsQuery = {};
  private valid = false;
  private sequence = 0;
  private request?: AbortController;
  private actor = this.workspace.fixture();
  private paged = false;
  constructor() {
    this.workspace.canLeave = () => this.canLeave();
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      this.poll.stop();
      this.following.set(false);
      const parsed = operationsScreenInput.safeParse(
        Object.fromEntries(
          ["view", "contentId", "recipientId", "status", "limit", "cursor"]
            .filter((key) => params.has(key))
            .map((key) => [key, params.get(key)]),
        ),
      );
      if (!parsed.success) {
        this.valid = false;
        this.sequence++;
        this.request?.abort();
        this.items.set([]);
        this.selected.set(undefined);
        this.cursor.set(undefined);
        this.loading.set(false);
        this.error.set("The operation filters are invalid.");
        return;
      }
      this.valid = true;
      this.query = parsed.data;
      this.view.set(parsed.data.view);
      this.filters.setValue({
        contentId: parsed.data.contentId ?? "",
        recipientId: parsed.data.recipientId ?? "",
        status: parsed.data.status ?? "",
      });
      void this.load(false);
    });
    effect(() => {
      const actor = this.workspace.fixture();
      if (actor !== this.actor) {
        this.actor = actor;
        if (this.query.cursor)
          void this.router.navigate(["/operations"], {
            queryParams: { ...this.query, cursor: undefined },
          });
        else void this.load(false);
      }
    });
    this.destroy.onDestroy(() => {
      this.sequence++;
      this.request?.abort();
      this.poll.destroy();
      this.workspace.canLeave = () => true;
    });
  }
  editor() {
    return this.workspace.fixture().startsWith("editor");
  }
  canLeave() {
    return !this.busy();
  }
  @HostListener("window:beforeunload", ["$event"]) beforeUnload(event: BeforeUnloadEvent) {
    if (this.busy()) event.preventDefault();
  }
  statuses() {
    return statuses[this.view()];
  }
  attempt(row: OperationRow): PublicationOperation | undefined {
    return "attempt" in row.data ? row.data : undefined;
  }
  notification(row: OperationRow): NotificationView | undefined {
    return "deliveryId" in row.data ? row.data : undefined;
  }
  failure(row: OperationRow): FailureSummary | undefined {
    return "consumer" in row.data ? row.data : undefined;
  }
  inspectParams(contentId: string) {
    return { ...this.query, contentId, cursor: undefined };
  }
  setView(view: "attempts" | "notifications" | "failures") {
    if (!this.busy())
      void this.router.navigate(["/operations"], {
        queryParams: {
          ...this.query,
          view,
          status: undefined,
          recipientId: undefined,
          cursor: undefined,
        },
      });
  }
  apply() {
    if (this.busy()) return;
    const value = this.filters.getRawValue();
    const input = {
      ...this.query,
      contentId: value.contentId.trim() || undefined,
      status: value.status || undefined,
      recipientId: this.view() === "notifications" ? value.recipientId || undefined : undefined,
      cursor: undefined,
    };
    const parsed = operationsScreenInput.safeParse(input);
    if (!parsed.success) {
      this.error.set("Choose valid operation filters and a content UUID.");
      return;
    }
    if (JSON.stringify(parsed.data) === JSON.stringify(this.query)) {
      void this.load(false);
      return;
    }
    void this.router.navigate(["/operations"], { queryParams: input });
  }
  authorityChanged(row: ContentResource) {
    this.selected.set(row);
    if (!this.paged && !this.following()) this.watch();
  }
  private pendingRows() {
    const p = this.selected()?.state.publication;
    return (
      (!!p &&
        ["queued", "running"].includes(p.phase) &&
        !publicationRecovery(p, Date.now()).expiredLease) ||
      this.items().some((row) => {
        const attempt = this.attempt(row)?.attempt;
        return (
          (attempt?.status === "claimed" && Date.parse(attempt.claim.leaseUntil) > Date.now()) ||
          ["reconciling", "replayQueued"].includes(this.failure(row)?.status ?? "")
        );
      })
    );
  }
  private watch() {
    this.following.set(true);
    this.poll.start(async (signal) => {
      if (this.busy()) return true;
      const sequence = this.sequence;
      try {
        const page = await this.workspace.client.operations(this.query, signal);
        if (signal.aborted || sequence !== this.sequence) return false;
        this.items.set(page.items);
        this.cursor.set(page.nextCursor);
        this.error.set("");
        const keep = this.pendingRows();
        this.following.set(keep);
        return keep;
      } catch {
        if (!signal.aborted && sequence === this.sequence)
          this.error.set("Pending operations could not be refreshed. Retrying while visible.");
        return true;
      }
    });
  }
  async load(append: boolean) {
    if (!this.valid || this.busy() || (append && this.loading())) return;
    this.poll.stop();
    this.following.set(false);
    this.paged = append;
    const sequence = ++this.sequence;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    if (!this.editor()) {
      this.items.set([]);
      this.selected.set(undefined);
      this.cursor.set(undefined);
      this.loading.set(false);
      this.error.set("");
      return;
    }
    const query = { ...this.query, ...(append && this.cursor() ? { cursor: this.cursor()! } : {}) };
    this.loading.set(true);
    this.error.set("");
    if (!append) {
      this.items.set([]);
      this.selected.set(undefined);
      this.cursor.set(undefined);
    }
    try {
      const [page, row] = await Promise.all([
        this.workspace.client.operations(query, request.signal),
        !append && query.contentId
          ? this.workspace.client.getContent(query.contentId, request.signal)
          : undefined,
      ]);
      if (sequence !== this.sequence) return;
      this.items.set([
        ...new Map(
          [...(append ? this.items() : []), ...page.items].map((item) => [item.itemId, item]),
        ).values(),
      ]);
      this.cursor.set(page.nextCursor);
      if (row) this.selected.set(row);
      if (!append && this.pendingRows()) this.watch();
    } catch {
      if (sequence === this.sequence && !request.signal.aborted)
        this.error.set("Operations could not be loaded. Refresh to retry.");
    } finally {
      if (sequence === this.sequence) this.loading.set(false);
    }
  }
}
