// @vitest-environment jsdom
import "@angular/compiler";
import { signal, provideZonelessChangeDetection, type Type } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from "@angular/router";
import { BehaviorSubject } from "rxjs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Workspace } from "../../src/web/workspace";
import {
  ContentOperationsClient,
  type ContentResource,
  type CalendarRow,
} from "../../src/web/client";
import { CalendarComponent } from "../../src/web/calendar";
import { ContentDetailComponent } from "../../src/web/content-detail";
import { SchedulingComponent } from "../../src/web/scheduling";
import { ScheduleSession } from "../../src/web/schedule-session";
import { PublicationComponent } from "../../src/web/publication";
import type { FixtureId } from "../../src/shared/identities";

const id = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const row = {
  resourceId: id,
  version: 4,
  state: {
    contentId: id,
    title: "Scheduled",
    body: "Body",
    status: "scheduled",
    authorId: "author_1",
    revisionId: id,
    approval: { reviewId: id, revisionId: id },
    schedule: {
      scheduledAt: "2027-04-01T03:30:00.000Z",
      timeZone: "America/New_York",
      generation: id,
      revisionId: id,
    },
    attachments: [],
    publication: null,
  },
} as unknown as ContentResource;
const calendarRow: CalendarRow = {
  projectionName: "contentItem.calendar",
  itemId: id,
  sort: "2027-04-01T03:30:00.000Z",
  data: {
    title: "Month boundary",
    status: "scheduled",
    authorId: "author_1",
    revisionId: id,
    version: 4,
    createdAt: "2027-03-01T00:00:00.000Z",
    updatedAt: "2027-03-01T00:00:00.000Z",
    scheduledAt: "2027-04-01T03:30:00.000Z",
    timeZone: "UTC",
    generation: id,
  },
};
function setup<T>(
  component: Type<T>,
  query: Record<string, string> = {},
  params: Record<string, string> = {},
) {
  const queryParamMap = new BehaviorSubject(convertToParamMap(query));
  const workspace = {
    fixture: signal<FixtureId>("editor_1"),
    client: new ContentOperationsClient({ fixture: () => "editor_1" }),
    listUrl: "/content",
    canLeave: () => true,
  };
  const fixture = TestBed.configureTestingModule({
    imports: [component],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: Workspace, useValue: workspace },
      {
        provide: ActivatedRoute,
        useValue: {
          queryParamMap,
          paramMap: new BehaviorSubject(convertToParamMap(params)),
          snapshot: { queryParamMap: convertToParamMap(query) },
        },
      },
    ],
  }).createComponent(component);
  return { fixture, component: fixture.componentInstance, workspace, queryParamMap };
}
describe("calendar and schedule components", () => {
  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("aborts superseded calendar reads and ignores a late response from another month", async () => {
    let finish!: (page: { items: CalendarRow[] }) => void;
    const request = vi
      .spyOn(ContentOperationsClient.prototype, "calendar")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce({ items: [] });
    const h = setup(CalendarComponent, { date: "2027-03-15", zone: "UTC" });
    h.fixture.detectChanges();
    h.queryParamMap.next(convertToParamMap({ date: "2027-04-15", zone: "UTC" }));
    finish({ items: [calendarRow] });
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    expect(request.mock.calls[0]![1]!.aborted).toBe(true);
    expect(h.component.state()?.date).toBe("2027-04-15");
    expect(h.component.items()).toEqual([]);
    h.fixture.destroy();
    expect(request.mock.calls[1]![1]!.aborted).toBe(true);
  });
  it("rejects invalid query state before fetch and preserves empty continuation/error semantics", async () => {
    const request = vi
      .spyOn(ContentOperationsClient.prototype, "calendar")
      .mockResolvedValue({ items: [], nextCursor: "opaque" });
    const h = setup(CalendarComponent, { date: "2027-02-30" });
    h.fixture.detectChanges();
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    expect(request).not.toHaveBeenCalled();
    expect(h.fixture.nativeElement.textContent).toContain("invalid");
    h.queryParamMap.next(convertToParamMap({ date: "2027-03-01", zone: "UTC" }));
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    expect(h.fixture.nativeElement.textContent).toContain("No scheduled items on this page");
    expect(h.fixture.nativeElement.textContent).toContain("Load more scheduled items");
    request.mockRejectedValue(new Error("private SDK text"));
    h.component.reload();
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    expect(h.fixture.nativeElement.textContent).toContain("could not be loaded");
    expect(h.fixture.nativeElement.textContent).not.toContain("private SDK text");
  });
  it("uses the same zoned instants across month and agenda without refetching on a view change", async () => {
    const request = vi
      .spyOn(ContentOperationsClient.prototype, "calendar")
      .mockResolvedValue({ items: [calendarRow] });
    const query = { date: "2027-03-15", zone: "America/New_York", view: "month" };
    const h = setup(CalendarComponent, query);
    h.fixture.detectChanges();
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    expect(h.component.days().find((day) => day.date === "2027-03-31")!.items).toHaveLength(1);
    expect(
      h.fixture.nativeElement.querySelector(".calendar-day-items time").getAttribute("datetime"),
    ).toBe(calendarRow.data.scheduledAt);
    h.queryParamMap.next(convertToParamMap({ ...query, view: "agenda" }));
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    expect(request).toHaveBeenCalledTimes(1);
    expect(h.component.groups()[0]!.date).toBe("2027-03-31");
    expect(h.fixture.nativeElement.querySelector(".agenda-row time").getAttribute("datetime")).toBe(
      calendarRow.data.scheduledAt,
    );
    expect(request.mock.calls[0]![0]).toMatchObject({
      from: "2027-03-01T05:00:00.000Z",
      before: "2027-04-01T04:00:00.000Z",
    });
  });
  it("drops a fixture-bound continuation when identity changes", async () => {
    vi.spyOn(ContentOperationsClient.prototype, "calendar").mockResolvedValue({ items: [] });
    const h = setup(CalendarComponent, { date: "2027-03-15", zone: "UTC", cursor: "bound" });
    const navigate = vi.spyOn(TestBed.inject(Router), "navigate").mockResolvedValue(true);
    h.fixture.detectChanges();
    await h.fixture.whenStable();
    h.workspace.fixture.set("author_2");
    h.fixture.detectChanges();
    expect(navigate).toHaveBeenCalledWith(["/calendar"], {
      queryParams: expect.objectContaining({ cursor: undefined, date: "2027-03-15", zone: "UTC" }),
    });
  });
  it("uses a real reactive scheduling form, rejects folds and focuses validation", async () => {
    const h = setup(SchedulingComponent);
    const session = new ScheduleSession(
      h.workspace.client,
      () => "editor_1",
      () => row,
      () => {},
      () => false,
    );
    session.reset(row);
    h.fixture.componentRef.setInput("session", session);
    h.fixture.detectChanges();
    session.form.setValue({ at: "2027-11-07T01:30", zone: "America/New_York" });
    const event = new Event("submit", { bubbles: true, cancelable: true });
    h.fixture.nativeElement.querySelector("form").dispatchEvent(event);
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    expect(event.defaultPrevented).toBe(true);
    expect(session.validation()).toContain("unambiguous");
    expect(
      h.fixture.nativeElement.querySelector('[aria-label="Scheduling"] [role="alert"]').textContent,
    ).toContain("repeated times");
    session.destroy();
  });
  it("guards dirty schedules and pending mutations, and retains a calendar return context", async () => {
    vi.spyOn(ContentOperationsClient.prototype, "getContent").mockResolvedValue(row);
    vi.spyOn(ContentOperationsClient.prototype, "activityPage").mockResolvedValue({ items: [] });
    const h = setup(
      ContentDetailComponent,
      {
        from: "calendar",
        date: "2027-03-15",
        zone: "America/New_York",
        view: "agenda",
        limit: "1",
        cursor: "prior-fixture-cursor",
        calendarFixture: "author_1",
      },
      { id },
    );
    h.fixture.detectChanges();
    await h.component.load();
    h.fixture.detectChanges();
    h.component.schedule.form.controls.at.setValue("2027-04-02T12:00");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(h.component.canLeave()).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    h.component.schedule.pending.set(true);
    expect(h.component.canLeave()).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    const event = new Event("beforeunload", { cancelable: true });
    h.component.beforeUnload(event as BeforeUnloadEvent);
    expect(event.defaultPrevented).toBe(true);
    expect(TestBed.inject(Router).serializeUrl(h.component.backLink())).toContain("view=agenda");
    expect(TestBed.inject(Router).serializeUrl(h.component.backLink())).not.toContain("cursor=");
    expect(h.component.backLabel()).toBe("Calendar");
  });
  it("never silently adopts a remote schedule generation while polling the due outcome", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    vi.spyOn(ContentOperationsClient.prototype, "getContent").mockResolvedValue({
      ...row,
      version: 5,
      state: { ...row.state, schedule: { ...row.state.schedule!, generation: other } },
    });
    vi.useFakeTimers();
    const h = setup(PublicationComponent);
    h.fixture.componentRef.setInput("row", row);
    h.fixture.detectChanges();
    const changed = vi.fn();
    h.component.changed.subscribe(changed);
    await vi.advanceTimersByTimeAsync(2000);
    expect(changed).not.toHaveBeenCalled();
    expect(h.component.row.version).toBe(4);
    expect(h.component.error()).toContain("schedule changed");
    h.fixture.destroy();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
