import { CommonModule } from "@angular/common";
import { Component, DestroyRef, effect, inject, signal } from "@angular/core";
import { FormControl, FormGroup, ReactiveFormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { JsStatusBadgeComponent, JsErrorPanelComponent } from "@jawstack/angular";
import { LucideRefreshCw, LucideArrowDown, LucideClipboardCheck } from "@lucide/angular";
import { reviewQueryInput, type ReviewQuery } from "../shared/api";
import { reviewStatuses } from "../shared/contracts";
import { editorIds } from "../shared/identities";
import { Workspace } from "./workspace";
import type { ReviewRow } from "./client";

@Component({
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterLink,
    JsStatusBadgeComponent,
    JsErrorPanelComponent,
    LucideRefreshCw,
    LucideArrowDown,
    LucideClipboardCheck,
  ],
  template: `
    <section class="page-heading">
      <div>
        <p class="eyebrow">EDITORIAL</p>
        <h1>Reviews</h1>
      </div>
      <button
        class="icon-button"
        aria-label="Refresh reviews"
        title="Refresh reviews"
        [disabled]="loading()"
        (click)="load(false)"
      >
        <svg lucideRefreshCw aria-hidden="true"></svg>
      </button>
    </section>
    <form class="filters review-filters" [formGroup]="filters">
      <label
        >Status<select aria-label="Review status" formControlName="status" (change)="apply()">
          <option value="all">All reviews</option>
          @for (status of statuses; track status) {
            <option [value]="status">{{ label(status) }}</option>
          }
        </select></label
      ><label
        >Assigned editor<select
          aria-label="Review assignment"
          formControlName="editorId"
          (change)="apply()"
        >
          <option value="">All editors</option>
          @for (editor of editors; track editor) {
            <option [value]="editor">{{ editor.replace("_", " ") }}</option>
          }
        </select></label
      ><label class="check-label"
        ><input type="checkbox" formControlName="overdue" (change)="apply()" />Overdue only</label
      >
    </form>
    <div class="results-heading">
      <span>{{ items().length }} review{{ items().length === 1 ? "" : "s" }} loaded</span>
      @if (contentId()) {
        <a class="inline-link" [routerLink]="['/content', contentId()]">Current content</a>
      }
    </div>
    @if (error()) {
      <js-error-panel title="Reviews unavailable" [message]="error()" /><button
        class="button"
        (click)="load(false)"
      >
        Try again
      </button>
    }
    @if (loading() && !items().length) {
      <div class="empty-state" role="status">
        <span class="spinner"></span>
        <h2>Loading reviews</h2>
      </div>
    } @else if (!items().length && !error()) {
      <div class="empty-state">
        <svg lucideClipboardCheck aria-hidden="true"></svg>
        <h2>{{ cursor() ? "No matches on this page" : "No matching reviews" }}</h2>
      </div>
    }
    <div class="review-table" role="table" aria-label="Review tasks">
      @if (items().length) {
        <div class="review-row table-header" role="row">
          <span role="columnheader">Submitted content</span><span role="columnheader">Status</span
          ><span role="columnheader">Assigned</span><span role="columnheader">Due (UTC)</span>
        </div>
      }
      @for (item of items(); track item.itemId) {
        <div class="review-row" role="row">
          <span role="cell"
            ><a
              class="inline-link review-title"
              [routerLink]="['/reviews', item.itemId]"
              [queryParams]="{ contentId: item.data.contentId }"
              >{{ item.data.title }}</a
            ><a class="muted content-reference" [routerLink]="['/content', item.data.contentId]"
              >Current content</a
            ></span
          ><span role="cell"><js-status-badge [value]="item.data.status" /></span
          ><span role="cell">{{ item.data.assignedEditorId.replace("_", " ") }}</span
          ><span role="cell"
            ><time [dateTime]="item.data.dueAt">{{
              item.data.dueAt | date: "MMM d, HH:mm" : "UTC"
            }}</time>
            @if (overdue(item)) {
              <span class="overdue-label">Overdue</span>
            }
          </span>
        </div>
      }
    </div>
    @if (cursor()) {
      <div class="pagination">
        <button class="button" [disabled]="loading()" (click)="load(true)">
          <svg lucideArrowDown aria-hidden="true"></svg>Load more reviews
        </button>
      </div>
    }
  `,
})
export class ReviewListComponent {
  readonly workspace = inject(Workspace);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly statuses = reviewStatuses;
  readonly editors = editorIds;
  readonly filters = new FormGroup({
    status: new FormControl("pending", { nonNullable: true }),
    editorId: new FormControl("", { nonNullable: true }),
    overdue: new FormControl(false, { nonNullable: true }),
  });
  readonly items = signal<ReviewRow[]>([]);
  readonly loading = signal(false);
  readonly error = signal("");
  readonly cursor = signal<string | undefined>(undefined);
  readonly contentId = signal<string | undefined>(undefined);
  private query: ReviewQuery = {};
  private valid = false;
  private request?: AbortController;
  private sequence = 0;
  private fixture = this.workspace.fixture();
  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const input: Record<string, unknown> = Object.fromEntries(
        ["editorId", "overdue", "limit", "cursor", "contentId"]
          .filter((key) => params.has(key))
          .map((key) => [key, params.get(key)]),
      );
      const status = params.get("status") ?? (params.has("contentId") ? "all" : "pending");
      if (status !== "all") input.status = status;
      const parsed = reviewQueryInput.safeParse(input);
      if (!parsed.success) {
        this.valid = false;
        this.sequence++;
        this.request?.abort();
        this.items.set([]);
        this.cursor.set(undefined);
        this.loading.set(false);
        this.error.set("The review filters are invalid.");
        return;
      }
      this.valid = true;
      this.query = parsed.data;
      this.contentId.set(parsed.data.contentId);
      this.filters.setValue({
        status,
        editorId: parsed.data.editorId ?? "",
        overdue: parsed.data.overdue === "true",
      });
      this.workspace.reviewsUrl = this.router.serializeUrl(
        this.router.createUrlTree(["/reviews"], {
          queryParams: Object.fromEntries(params.keys.map((key) => [key, params.get(key)])),
        }),
      );
      void this.load(false);
    });
    effect(() => {
      const actor = this.workspace.fixture();
      if (actor !== this.fixture) {
        this.fixture = actor;
        if (this.query.cursor)
          void this.router.navigate([], {
            relativeTo: this.route,
            queryParams: { cursor: null },
            queryParamsHandling: "merge",
          });
        else void this.load(false);
      }
    });
    inject(DestroyRef).onDestroy(() => {
      this.sequence++;
      this.request?.abort();
    });
  }
  label(status: string) {
    return (
      {
        pending: "Pending",
        approved: "Approved",
        changesRequested: "Changes requested",
        superseded: "Superseded",
      }[status] ?? status
    );
  }
  overdue(row: ReviewRow) {
    return row.data.status === "pending" && Date.parse(row.data.dueAt) <= Date.now();
  }
  apply() {
    const value = this.filters.getRawValue();
    void this.router.navigate(["/reviews"], {
      queryParams: {
        status: value.status,
        editorId: value.editorId || undefined,
        overdue: value.overdue ? "true" : undefined,
        contentId: this.contentId(),
      },
    });
  }
  async load(append: boolean) {
    if (!this.valid || (append && this.loading())) return;
    const sequence = ++this.sequence;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    const query = { ...this.query, ...(append && this.cursor() ? { cursor: this.cursor()! } : {}) };
    this.loading.set(true);
    this.error.set("");
    if (!append) {
      this.items.set([]);
      this.cursor.set(undefined);
    }
    try {
      const page = await this.workspace.client.reviews(query, request.signal);
      if (sequence !== this.sequence) return;
      this.items.set([
        ...new Map(
          [...(append ? this.items() : []), ...page.items].map((row) => [row.itemId, row]),
        ).values(),
      ]);
      this.cursor.set(page.nextCursor);
    } catch {
      if (sequence === this.sequence && !request.signal.aborted)
        this.error.set("Reviews could not be loaded.");
    } finally {
      if (sequence === this.sequence) this.loading.set(false);
    }
  }
}
