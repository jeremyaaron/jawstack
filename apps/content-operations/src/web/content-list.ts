import { CommonModule } from "@angular/common";
import { Component, DestroyRef, effect, inject, signal } from "@angular/core";
import { FormControl, FormGroup, ReactiveFormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import {
  LucidePlus,
  LucideSearch,
  LucideList,
  LucideColumns3,
  LucideRefreshCw,
  LucideArrowDown,
  LucideFileText,
} from "@lucide/angular";
import { JsStatusBadgeComponent, JsErrorPanelComponent } from "@jawstack/angular";
import { contentStatuses } from "../shared/contracts";
import { contentQueryInput, type ContentQuery } from "../shared/api";
import { fixtureIds } from "../shared/identities";
import { type ContentRow } from "./client";
import { Workspace } from "./workspace";

export const statusLabel = (status: string) =>
  ({
    draft: "Draft",
    inReview: "In review",
    approved: "Approved",
    scheduled: "Scheduled",
    publishing: "Publishing",
    published: "Published",
    archived: "Archived",
  })[status] ?? status;

@Component({
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterLink,
    JsStatusBadgeComponent,
    JsErrorPanelComponent,
    LucidePlus,
    LucideSearch,
    LucideList,
    LucideColumns3,
    LucideRefreshCw,
    LucideArrowDown,
    LucideFileText,
  ],
  template: `
    <section class="page-heading">
      <div>
        <p class="eyebrow">WORKBENCH</p>
        <h1>Content</h1>
      </div>
      <a class="button primary" routerLink="/content/new"
        ><svg lucidePlus aria-hidden="true"></svg>New content</a
      >
    </section>
    <div class="list-toolbar">
      <form class="filters" [formGroup]="filters" (ngSubmit)="applyFilters()">
        <label class="search"
          ><svg lucideSearch aria-hidden="true"></svg
          ><input
            aria-label="Search title"
            formControlName="title"
            placeholder="Search titles"
            maxlength="160"
        /></label>
        <label
          ><span class="sr-only">Status</span
          ><select aria-label="Status filter" formControlName="status" (change)="applyFilters()">
            <option value="">All active statuses</option>
            @for (status of statuses; track status) {
              <option [value]="status">{{ label(status) }}</option>
            }
          </select></label
        >
        <label
          ><span class="sr-only">Author</span
          ><select aria-label="Author filter" formControlName="authorId" (change)="applyFilters()">
            <option value="">All authors</option>
            @for (author of authors; track author) {
              <option [value]="author">{{ author.replace("_", " ") }}</option>
            }
          </select></label
        >
        <button type="submit" class="icon-button" title="Apply filters" aria-label="Apply filters">
          <svg lucideSearch aria-hidden="true"></svg>
        </button>
      </form>
      <div class="view-tools">
        <button
          class="icon-button"
          title="Refresh content"
          aria-label="Refresh content"
          [disabled]="loading()"
          (click)="reload()"
        >
          <svg lucideRefreshCw aria-hidden="true"></svg>
        </button>
        <div class="segmented" role="group" aria-label="Content view">
          <button
            class="icon-button"
            title="List view"
            aria-label="List view"
            [attr.aria-pressed]="view() === 'list'"
            (click)="setView('list')"
          >
            <svg lucideList aria-hidden="true"></svg></button
          ><button
            class="icon-button"
            title="Board view"
            aria-label="Board view"
            [attr.aria-pressed]="view() === 'board'"
            (click)="setView('board')"
          >
            <svg lucideColumns3 aria-hidden="true"></svg>
          </button>
        </div>
      </div>
    </div>
    <div class="results-heading">
      <span>{{ items().length }} item{{ items().length === 1 ? "" : "s" }} loaded</span>
      @if (hasFilters()) {
        <button class="text-button" (click)="clearFilters()">Clear filters</button>
      }
    </div>
    @if (error()) {
      <js-error-panel title="Content unavailable" [message]="error()" /><button
        class="button"
        (click)="reload()"
      >
        Try again
      </button>
    }
    @if (loading() && !items().length) {
      <div class="empty-state" role="status">
        <span class="spinner"></span>
        <h2>Loading content</h2>
      </div>
    } @else if (!error() && !items().length) {
      <div class="empty-state">
        <svg lucideFileText aria-hidden="true"></svg>
        <h2>
          {{
            nextCursor()
              ? "No matches on this page"
              : hasFilters()
                ? "No matching content"
                : "No content yet"
          }}
        </h2>
        @if (!hasFilters() && !nextCursor()) {
          <a class="button" routerLink="/content/new"
            ><svg lucidePlus aria-hidden="true"></svg>New content</a
          >
        }
      </div>
    }
    @if (items().length && view() === "list") {
      <div class="content-table" role="table" aria-label="Content items">
        <div class="table-header" role="row">
          <span role="columnheader">Title</span><span role="columnheader">Status</span
          ><span role="columnheader">Author</span><span role="columnheader">Updated</span>
        </div>
        @for (item of items(); track item.itemId) {
          <div class="content-row" role="row">
            <span class="content-title" role="cell"
              ><svg lucideFileText aria-hidden="true"></svg
              ><span
                ><a class="item-link" [routerLink]="['/content', item.itemId]">{{
                  item.data.title
                }}</a
                ><small>Version {{ item.data.version }}</small></span
              ></span
            ><span role="cell"><js-status-badge [value]="item.data.status" /></span
            ><span class="author-cell" role="cell">{{ item.data.authorId.replace("_", " ") }}</span
            ><time role="cell" [dateTime]="item.data.updatedAt">{{
              item.data.updatedAt | date: "MMM d, HH:mm"
            }}</time>
          </div>
        }
      </div>
    } @else if (items().length) {
      <div class="board">
        @for (status of visibleStatuses(); track status) {
          <section class="board-column" [attr.aria-label]="label(status)">
            <header>
              <span class="status-dot" [attr.data-status]="status"></span>
              <h2>{{ label(status) }}</h2>
              <span>{{ rows(status).length }}</span>
            </header>
            @for (item of rows(status); track item.itemId) {
              <a class="content-card" [routerLink]="['/content', item.itemId]"
                ><h3>{{ item.data.title }}</h3>
                <p>
                  {{ item.data.authorId.replace("_", " ") }}<span>v{{ item.data.version }}</span>
                </p>
                <time [dateTime]="item.data.updatedAt">{{
                  item.data.updatedAt | date: "MMM d, HH:mm"
                }}</time></a
              >
            }
            @if (!rows(status).length) {
              <p class="column-empty">No items</p>
            }
          </section>
        }
      </div>
    }
    @if (nextCursor()) {
      <div class="pagination">
        <button class="button" [disabled]="loading()" (click)="loadMore()">
          <svg lucideArrowDown aria-hidden="true"></svg>{{ loading() ? "Loading" : "Load more" }}
        </button>
      </div>
    }
  `,
})
export class ContentListComponent {
  readonly workspace = inject(Workspace);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  readonly statuses = contentStatuses;
  readonly authors = fixtureIds;
  readonly label = statusLabel;
  readonly filters = new FormGroup({
    title: new FormControl("", { nonNullable: true }),
    status: new FormControl("", { nonNullable: true }),
    authorId: new FormControl("", { nonNullable: true }),
  });
  readonly items = signal<ContentRow[]>([]);
  readonly loading = signal(false);
  readonly error = signal("");
  readonly nextCursor = signal<string | undefined>(undefined);
  readonly view = signal<"list" | "board">("list");
  private query: ContentQuery = {};
  private request: AbortController | undefined;
  private sequence = 0;
  private validQuery = true;
  private queryKey = "";
  private activeFixture = this.workspace.fixture();
  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      this.view.set(params.get("view") === "board" ? "board" : "list");
      const parsed = contentQueryInput.safeParse(
        Object.fromEntries(
          ["title", "status", "authorId", "cursor", "limit"]
            .filter((key) => params.has(key))
            .map((key) => [key, params.get(key)]),
        ),
      );
      if (!parsed.success) {
        this.validQuery = false;
        this.queryKey = "";
        this.sequence++;
        this.request?.abort();
        this.error.set("The content filters are invalid.");
        this.items.set([]);
        this.nextCursor.set(undefined);
        this.loading.set(false);
        return;
      }
      this.validQuery = true;
      this.query = parsed.data;
      this.filters.setValue({
        title: params.get("title") ?? "",
        status: params.get("status") ?? "",
        authorId: params.get("authorId") ?? "",
      });
      this.workspace.listUrl = this.router.serializeUrl(
        this.router.createUrlTree(["/content"], {
          queryParams: Object.fromEntries(params.keys.map((key) => [key, params.get(key)])),
        }),
      );
      const key = JSON.stringify(this.query);
      if (key !== this.queryKey) {
        this.queryKey = key;
        void this.fetchPage(false);
      }
    });
    effect(() => {
      const actor = this.workspace.fixture();
      if (actor !== this.activeFixture) {
        this.activeFixture = actor;
        if (this.query.cursor)
          void this.router.navigate([], {
            relativeTo: this.route,
            queryParams: { cursor: null },
            queryParamsHandling: "merge",
          });
        else void this.fetchPage(false);
      }
    });
    this.destroy.onDestroy(() => this.request?.abort());
  }
  hasFilters() {
    return !!(this.query.title || this.query.status || this.query.authorId);
  }
  rows(status: string) {
    return this.items().filter((row) => row.data.status === status);
  }
  visibleStatuses() {
    return this.query.status
      ? [this.query.status]
      : this.statuses.filter((status) => status !== "archived");
  }
  applyFilters() {
    const value = this.filters.getRawValue();
    void this.router.navigate(["/content"], {
      queryParams: {
        title: value.title.trim() || undefined,
        status: value.status || undefined,
        authorId: value.authorId || undefined,
        view: this.view(),
      },
    });
  }
  clearFilters() {
    void this.router.navigate(["/content"], { queryParams: { view: this.view() } });
  }
  setView(view: "list" | "board") {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { view },
      queryParamsHandling: "merge",
    });
  }
  reload() {
    void this.fetchPage(false);
  }
  loadMore() {
    if (!this.loading() && this.nextCursor()) void this.fetchPage(true);
  }
  private async fetchPage(append: boolean) {
    if (!this.validQuery) return;
    const sequence = ++this.sequence;
    this.request?.abort();
    this.request = new AbortController();
    this.loading.set(true);
    this.error.set("");
    if (!append) {
      this.items.set([]);
      this.nextCursor.set(undefined);
    }
    const query = { ...this.query };
    if (append) query.cursor = this.nextCursor()!;
    try {
      const result = await this.workspace.client.content(query, this.request.signal);
      if (sequence !== this.sequence) return;
      const items = append ? [...this.items(), ...result.items] : result.items;
      this.items.set([...new Map(items.map((row) => [row.itemId, row])).values()]);
      this.nextCursor.set(result.nextCursor);
    } catch (error) {
      if (sequence === this.sequence && !this.request.signal.aborted)
        this.error.set(error instanceof Error ? error.message : "Content could not be loaded.");
    } finally {
      if (sequence === this.sequence) this.loading.set(false);
    }
  }
}
