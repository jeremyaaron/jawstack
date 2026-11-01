import { CommonModule } from "@angular/common";
import { Component, DestroyRef, Input, effect, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { JsErrorPanelComponent } from "@jawstack/angular";
import { LucideArrowDown, LucideRefreshCw } from "@lucide/angular";
import { Workspace } from "./workspace";
import type { ActivityPage } from "./client";

@Component({
  selector: "content-activity",
  standalone: true,
  imports: [CommonModule, RouterLink, JsErrorPanelComponent, LucideArrowDown, LucideRefreshCw],
  template: `
    <section class="activity-section" aria-label="Activity">
      <header class="section-heading">
        <h2>Activity</h2>
        <button
          class="icon-button"
          aria-label="Refresh activity"
          title="Refresh activity"
          [disabled]="loading()"
          (click)="load(false)"
        >
          <svg lucideRefreshCw aria-hidden="true"></svg>
        </button>
      </header>
      @if (error()) {
        <js-error-panel title="Activity unavailable" [message]="error()" />
      }
      @if (loading() && !items().length) {
        <p class="muted" role="status">Loading activity</p>
      } @else if (!error() && !items().length) {
        <p class="muted">{{ cursor() ? "No activity on this page" : "No activity recorded" }}</p>
      }
      <ol class="activity-list">
        @for (item of items(); track item.activityId) {
          <li>
            <span class="activity-dot"></span>
            <div>
              <strong>{{ item.title }}</strong>
              <p>
                {{ item.actor?.displayName ?? item.actor?.subject ?? "System" }} <span>·</span>
                <time [dateTime]="item.occurredAt">{{
                  item.occurredAt | date: "MMM d, yyyy, HH:mm:ss"
                }}</time>
              </p>
              @if (item.summary) {
                <p>{{ item.summary }}</p>
              }
              @if (item.data?.reviewId) {
                <a
                  class="inline-link"
                  [routerLink]="['/reviews', item.data!.reviewId]"
                  [queryParams]="{ contentId: contentId }"
                  >Review snapshot</a
                >
              }
            </div>
          </li>
        }
      </ol>
      @if (cursor()) {
        <button class="button" [disabled]="loading()" (click)="load(true)">
          <svg lucideArrowDown aria-hidden="true"></svg>Load more activity
        </button>
      }
    </section>
  `,
})
export class ActivityComponent {
  @Input({ required: true }) resourceId = "";
  @Input({ required: true }) contentId = "";
  @Input() resourceType: "contentItem" | "reviewTask" = "contentItem";
  @Input() version = 0;
  readonly workspace = inject(Workspace);
  readonly items = signal<ActivityPage["items"]>([]);
  readonly cursor = signal<string | undefined>(undefined);
  readonly loading = signal(false);
  readonly error = signal("");
  private request?: AbortController;
  private sequence = 0;
  private fixture = this.workspace.fixture();
  constructor() {
    effect(() => {
      const fixture = this.workspace.fixture();
      if (fixture !== this.fixture) {
        this.fixture = fixture;
        if (this.resourceId) void this.load(false);
      }
    });
    inject(DestroyRef).onDestroy(() => {
      this.sequence++;
      this.request?.abort();
    });
  }
  ngOnChanges() {
    if (this.resourceId) void this.load(false);
  }
  async load(append: boolean) {
    if (append && this.loading()) return;
    const sequence = ++this.sequence;
    this.request?.abort();
    this.request = new AbortController();
    this.loading.set(true);
    this.error.set("");
    const cursor = append ? this.cursor() : undefined;
    if (!append) {
      this.items.set([]);
      this.cursor.set(undefined);
    }
    try {
      const page = await this.workspace.client.activityPage(
        this.resourceType,
        this.resourceId,
        { limit: 5, ...(cursor ? { cursor } : {}) },
        this.request.signal,
      );
      if (sequence !== this.sequence) return;
      this.items.set([
        ...new Map(
          [...(append ? this.items() : []), ...page.items].map((row) => [row.activityId, row]),
        ).values(),
      ]);
      this.cursor.set(page.nextCursor);
    } catch {
      if (sequence === this.sequence && !this.request.signal.aborted)
        this.error.set("Activity could not be loaded.");
    } finally {
      if (sequence === this.sequence) this.loading.set(false);
    }
  }
}
