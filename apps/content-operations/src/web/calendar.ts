import { CommonModule } from "@angular/common";
import { Component, DestroyRef, computed, effect, inject, signal } from "@angular/core";
import { FormControl, FormGroup, ReactiveFormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import {
  LucideCalendarDays,
  LucideList,
  LucideChevronLeft,
  LucideChevronRight,
  LucideRefreshCw,
  LucideArrowDown,
} from "@lucide/angular";
import { JsErrorPanelComponent } from "@jawstack/angular";
import {
  calendarState,
  calendarMonth,
  shiftCalendarMonth,
  type CalendarState,
} from "../shared/calendar";
import { localDateAt, zonedLabel, timeZones } from "../shared/time";
import { timeZoneSchema } from "../shared/validation";
import type { CalendarRow } from "./client";
import { Workspace } from "./workspace";

@Component({
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterLink,
    JsErrorPanelComponent,
    LucideCalendarDays,
    LucideList,
    LucideChevronLeft,
    LucideChevronRight,
    LucideRefreshCw,
    LucideArrowDown,
  ],
  template: `
    <section class="page-heading">
      <div>
        <p class="eyebrow">PUBLICATION SCHEDULE</p>
        <h1>Calendar</h1>
      </div>
      <div class="segmented" role="group" aria-label="Calendar view">
        <button
          type="button"
          class="icon-button"
          title="Month view"
          aria-label="Month view"
          [attr.aria-pressed]="state()?.view !== 'agenda'"
          (click)="setView('month')"
        >
          <svg lucideCalendarDays aria-hidden="true"></svg>
        </button>
        <button
          type="button"
          class="icon-button"
          title="Agenda view"
          aria-label="Agenda view"
          [attr.aria-pressed]="state()?.view === 'agenda'"
          (click)="setView('agenda')"
        >
          <svg lucideList aria-hidden="true"></svg>
        </button>
      </div>
    </section>
    <div class="calendar-toolbar">
      <form class="calendar-filters" [formGroup]="filters" (ngSubmit)="apply()">
        <label for="calendar-date"
          >Date<input id="calendar-date" type="date" formControlName="date" required
        /></label>
        <label for="calendar-zone"
          >Display time zone<select
            id="calendar-zone"
            aria-label="Display time zone"
            formControlName="zone"
          >
            @for (zone of zones(); track zone) {
              <option [value]="zone">{{ zone }}</option>
            }
          </select></label
        >
        <button type="submit" class="button">Apply</button>
      </form>
      <div class="view-tools">
        <button class="button" type="button" (click)="today()">Today</button
        ><button
          class="icon-button"
          type="button"
          aria-label="Refresh calendar"
          title="Refresh calendar"
          [disabled]="loading()"
          (click)="reload()"
        >
          <svg lucideRefreshCw aria-hidden="true"></svg>
        </button>
      </div>
    </div>
    @if (error()) {
      <js-error-panel title="Calendar unavailable" [message]="error()" />
    }
    @if (month(); as month) {
      <header class="calendar-month-heading">
        <button
          class="icon-button"
          type="button"
          aria-label="Previous month"
          title="Previous month"
          [disabled]="!shifted(-1)"
          (click)="shift(-1)"
        >
          <svg lucideChevronLeft aria-hidden="true"></svg>
        </button>
        <h2>{{ month.title }}</h2>
        <button
          class="icon-button"
          type="button"
          aria-label="Next month"
          title="Next month"
          [disabled]="!shifted(1)"
          (click)="shift(1)"
        >
          <svg lucideChevronRight aria-hidden="true"></svg>
        </button>
      </header>
      <div class="results-heading">
        <span>{{ items().length }} scheduled item{{ items().length === 1 ? "" : "s" }} loaded</span
        ><span>{{ state()!.zone }}</span>
      </div>
      <p class="calendar-loading" role="status">
        {{
          loading()
            ? "Loading scheduled content"
            : !error() && !items().length
              ? nextCursor()
                ? "No scheduled items on this page"
                : "No scheduled content this month"
              : ""
        }}
      </p>
      @if (state()!.view === "month") {
        <div class="month-calendar" role="region" aria-label="Scheduled month">
          <div class="calendar-weekdays" aria-hidden="true">
            @for (day of weekdays; track day) {
              <span>{{ day }}</span>
            }
          </div>
          <div class="calendar-grid">
            @for (day of days(); track day.date) {
              <section
                class="calendar-day"
                [class.outside-month]="!day.inMonth"
                [class.selected-day]="day.date === state()!.date"
                [attr.aria-label]="day.label"
              >
                <button
                  class="day-button"
                  type="button"
                  [disabled]="!day.inMonth"
                  [attr.aria-label]="
                    day.label + ', ' + day.items.length + ' scheduled items loaded'
                  "
                  [attr.aria-current]="day.date === state()!.date ? 'date' : null"
                  (click)="showDay(day.date)"
                >
                  <span>{{ day.day }}</span>
                  @if (day.items.length) {
                    <span class="calendar-day-count">{{ day.items.length }}</span>
                  }
                </button>
                <ul class="calendar-day-items">
                  @for (row of day.items; track row.itemId) {
                    <li>
                      <a [routerLink]="['/content', row.itemId]" [queryParams]="detailParams()"
                        ><time [dateTime]="row.data.scheduledAt">{{
                          clockLabel(row.data.scheduledAt)
                        }}</time
                        ><span>{{ row.data.title }}</span></a
                      >
                    </li>
                  }
                </ul>
              </section>
            }
          </div>
        </div>
      } @else {
        <section class="calendar-agenda" aria-label="Scheduled agenda">
          @for (group of groups(); track group.date) {
            <section
              class="agenda-day"
              [class.selected-agenda-day]="group.date === state()!.date"
              [attr.aria-label]="group.date"
            >
              <h3>{{ group.date }}</h3>
              @for (row of group.items; track row.itemId) {
                <div class="agenda-row">
                  <div>
                    <a
                      class="item-link"
                      [routerLink]="['/content', row.itemId]"
                      [queryParams]="detailParams()"
                      >{{ row.data.title }}</a
                    ><small
                      >{{ row.data.authorId.replace("_", " ") }} · Scheduled in
                      {{ row.data.timeZone }}</small
                    >
                  </div>
                  <time [dateTime]="row.data.scheduledAt">{{
                    label(row.data.scheduledAt, state()!.zone)
                  }}</time>
                </div>
              }
            </section>
          }
        </section>
      }
      @if (nextCursor()) {
        <div class="pagination">
          <button type="button" class="button" [disabled]="loading()" (click)="loadMore()">
            <svg lucideArrowDown aria-hidden="true"></svg
            >{{ loading() ? "Loading" : "Load more scheduled items" }}
          </button>
        </div>
      }
    }
  `,
})
export class CalendarComponent {
  readonly workspace = inject(Workspace);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  readonly filters = new FormGroup({
    date: new FormControl("", { nonNullable: true }),
    zone: new FormControl("UTC", { nonNullable: true }),
  });
  readonly state = signal<CalendarState | undefined>(undefined);
  readonly month = computed(() => {
    const state = this.state();
    return state ? calendarMonth(state.date, state.zone) : undefined;
  });
  readonly items = signal<CalendarRow[]>([]);
  readonly nextCursor = signal<string | undefined>(undefined);
  readonly loading = signal(false);
  readonly error = signal("");
  readonly weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  readonly label = zonedLabel;
  readonly groups = computed(() => {
    const zone = this.state()?.zone;
    if (!zone) return [];
    const groups = new Map<string, CalendarRow[]>();
    for (const row of this.items()) {
      const date = localDateAt(row.data.scheduledAt, zone);
      const items = groups.get(date) ?? [];
      items.push(row);
      groups.set(date, items);
    }
    return [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, items]) => ({ date, items }));
  });
  readonly days = computed(() => {
    const groups = new Map(this.groups().map((group) => [group.date, group.items]));
    return this.month()?.days.map((day) => ({ ...day, items: groups.get(day.date) ?? [] })) ?? [];
  });
  private sequence = 0;
  private request: AbortController | undefined;
  private queryKey = "";
  private actor = this.workspace.fixture();
  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      try {
        const state = calendarState(
          Object.fromEntries(
            ["date", "zone", "view", "limit", "cursor"]
              .filter((key) => params.has(key))
              .map((key) => [key, params.get(key)]),
          ),
        );
        const range = calendarMonth(state.date, state.zone).query;
        const key = JSON.stringify([range.from, range.before, state.limit, state.cursor]);
        this.state.set(state);
        this.filters.setValue({ date: state.date, zone: state.zone });
        if (key !== this.queryKey) {
          this.queryKey = key;
          void this.fetchPage(false);
        }
      } catch {
        this.sequence++;
        this.request?.abort();
        this.queryKey = "";
        this.state.set(undefined);
        this.items.set([]);
        this.nextCursor.set(undefined);
        this.loading.set(false);
        this.error.set("The calendar date, time zone, view, or paging parameters are invalid.");
      }
    });
    effect(() => {
      const actor = this.workspace.fixture();
      if (actor !== this.actor) {
        this.actor = actor;
        if (this.state()?.cursor) this.navigate({ cursor: undefined });
        else void this.fetchPage(false);
      }
    });
    this.destroy.onDestroy(() => {
      this.sequence++;
      this.request?.abort();
    });
  }
  zones() {
    return timeZones(this.filters.controls.zone.value);
  }
  detailParams() {
    return { ...this.state(), from: "calendar", calendarFixture: this.workspace.fixture() };
  }
  clockLabel(instant: string) {
    return new Intl.DateTimeFormat("en", {
      timeZone: this.state()!.zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(instant));
  }
  apply() {
    try {
      const value = this.filters.getRawValue();
      calendarState(value);
      if (value.date === this.state()?.date && value.zone === this.state()?.zone) {
        this.reload();
        return;
      }
      this.navigate({ ...value, cursor: undefined });
    } catch {
      this.error.set("Choose a valid date and IANA time zone.");
    }
  }
  today() {
    const parsed = timeZoneSchema.safeParse(this.filters.controls.zone.value);
    const zone = parsed.success ? parsed.data : "UTC";
    this.navigate({ date: localDateAt(new Date().toISOString(), zone), zone, cursor: undefined });
  }
  shifted(months: number) {
    const date = this.state()?.date;
    return date ? shiftCalendarMonth(date, months) : undefined;
  }
  shift(months: number) {
    const date = this.shifted(months);
    if (date) this.navigate({ date, cursor: undefined });
  }
  showDay(date: string) {
    this.navigate({ date, view: "agenda" });
  }
  setView(view: "month" | "agenda") {
    this.navigate({ view });
  }
  private navigate(changes: Partial<CalendarState>) {
    void this.router.navigate(["/calendar"], {
      queryParams: { ...calendarState({}), ...this.state(), ...changes },
    });
  }
  reload() {
    void this.fetchPage(false);
  }
  loadMore() {
    if (!this.loading() && this.nextCursor()) void this.fetchPage(true);
  }
  private async fetchPage(append: boolean) {
    const state = this.state();
    const month = this.month();
    if (!state || !month) return;
    const sequence = ++this.sequence;
    this.request?.abort();
    this.request = new AbortController();
    this.loading.set(true);
    this.error.set("");
    const cursor = append ? this.nextCursor() : state.cursor;
    if (!append) {
      this.items.set([]);
      this.nextCursor.set(undefined);
    }
    try {
      const page = await this.workspace.client.calendar(
        { ...month.query, limit: state.limit, ...(cursor ? { cursor } : {}) },
        this.request.signal,
      );
      if (sequence !== this.sequence) return;
      this.items.set([
        ...new Map(
          (append ? [...this.items(), ...page.items] : page.items).map((row) => [row.itemId, row]),
        ).values(),
      ]);
      this.nextCursor.set(page.nextCursor);
    } catch {
      if (sequence === this.sequence && !this.request.signal.aborted)
        this.error.set("Scheduled content could not be loaded. Refresh to retry.");
    } finally {
      if (sequence === this.sequence) this.loading.set(false);
    }
  }
}
