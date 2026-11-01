// @vitest-environment jsdom
import "@angular/compiler";
import { signal, provideZonelessChangeDetection } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { ActivatedRoute, convertToParamMap, provideRouter } from "@angular/router";
import { BehaviorSubject } from "rxjs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Workspace } from "../../src/web/workspace";
import { OperationsComponent } from "../../src/web/operations";
import { ContentOperationsClient, type OperationRow } from "../../src/web/client";
import type { FixtureId } from "../../src/shared/identities";

const id = "10000000-0000-4000-8000-000000000001";
const attempt = (status: "claimed" | "succeeded" = "claimed"): OperationRow => ({
  projectionName: "contentItem.publicationAttempts",
  itemId: id,
  sort: id,
  data: {
    kind: "publicationAttempt",
    contentId: id,
    publicationId: id,
    transitionEventId: "transition",
    causationId: "cause",
    attempt: {
      generation: 1,
      claim: {
        attemptId: id,
        startedAt: "2027-03-01T12:00:00.000Z",
        leaseUntil: "2027-03-01T12:01:30.000Z",
      },
      status,
      finishedAt: status === "claimed" ? null : "2027-03-01T12:00:01.000Z",
      failureCode: null,
      sourceEventId: "source",
      correlationId: "trace-actual",
    },
  },
});
function setup(query: Record<string, string> = {}, actor: FixtureId = "editor_1") {
  const queryParamMap = new BehaviorSubject(convertToParamMap(query));
  const workspace = {
    fixture: signal<FixtureId>(actor),
    client: new ContentOperationsClient({ fixture: () => actor }),
    canLeave: () => true,
  };
  const fixture = TestBed.configureTestingModule({
    imports: [OperationsComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: Workspace, useValue: workspace },
      { provide: ActivatedRoute, useValue: { queryParamMap } },
    ],
  }).createComponent(OperationsComponent);
  return { fixture, component: fixture.componentInstance, workspace, queryParamMap };
}
describe("operation views", () => {
  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("does not fetch privileged data for authors and rejects invalid view/status filters", async () => {
    const fetch = vi
      .spyOn(ContentOperationsClient.prototype, "operations")
      .mockResolvedValue({ items: [] });
    const h = setup({}, "author_1");
    h.fixture.detectChanges();
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    expect(fetch).not.toHaveBeenCalled();
    expect(h.fixture.nativeElement.textContent).toContain("Editor access required");
    h.workspace.fixture.set("editor_1");
    h.queryParamMap.next(convertToParamMap({ view: "notifications", status: "claimed" }));
    h.fixture.detectChanges();
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    expect(fetch).not.toHaveBeenCalled();
    expect(h.component.error()).toContain("invalid");
  });
  it("preserves empty continuation, reports sanitized errors and gates pending navigation", async () => {
    const fetch = vi
      .spyOn(ContentOperationsClient.prototype, "operations")
      .mockResolvedValue({ items: [], nextCursor: "next" });
    const h = setup();
    h.fixture.detectChanges();
    await h.component.load(false);
    h.fixture.detectChanges();
    expect(h.fixture.nativeElement.textContent).toContain("No matches on this page");
    expect(h.fixture.nativeElement.textContent).toContain("Load more operations");
    h.component.busy.set(true);
    expect(h.component.canLeave()).toBe(false);
    const event = new Event("beforeunload", { cancelable: true });
    h.component.beforeUnload(event as BeforeUnloadEvent);
    expect(event.defaultPrevented).toBe(true);
    h.component.busy.set(false);
    fetch.mockRejectedValue(new Error("private SDK detail"));
    await h.component.load(false);
    h.fixture.detectChanges();
    expect(h.component.error()).toContain("could not be loaded");
    expect(h.fixture.nativeElement.textContent).not.toContain("private SDK detail");
  });
  it("follows only the initial page, stops on settlement, preserves explicitly appended pages and cleans timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2027-03-01T12:00:00.000Z");
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const fetch = vi
      .spyOn(ContentOperationsClient.prototype, "operations")
      .mockResolvedValueOnce({ items: [attempt()], nextCursor: "next" })
      .mockResolvedValue({ items: [attempt("succeeded")], nextCursor: "next" });
    const h = setup();
    h.fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    h.fixture.detectChanges();
    await vi.waitFor(() => expect(h.component.loading()).toBe(false));
    expect(h.component.following()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.component.following()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    await h.component.load(true);
    expect(h.component.following()).toBe(false);
    expect(h.component.items()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20000);
    expect(fetch).toHaveBeenCalledTimes(3);
    h.fixture.destroy();
    await vi.advanceTimersByTimeAsync(20000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("shows actual correlation details and escapes notification messages rather than embedding markup", async () => {
    vi.spyOn(ContentOperationsClient.prototype, "operations").mockResolvedValue({
      items: [
        {
          projectionName: "contentItem.notifications",
          itemId: "a".repeat(64),
          sort: id,
          data: {
            deliveryId: "a".repeat(64),
            sourceEventId: "source",
            transportEventId: "transport",
            eventType: "contentItem.published",
            contentId: id,
            reviewId: null,
            publicationId: id,
            recipientId: "author_1",
            template: "publication-succeeded.v1",
            channel: "local",
            status: "succeeded",
            subject: "<img src=x onerror=alert(1)>",
            message: "<script>not executable</script>",
            payloadHash: "b".repeat(64),
            occurredAt: "2027-03-01T12:00:00.000Z",
            deliveredAt: "2027-03-01T12:00:00.000Z",
            correlationId: "trace-actual",
            causationId: "cause",
          },
        },
      ],
    });
    const h = setup({ view: "notifications" });
    h.fixture.detectChanges();
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    await h.component.load(false);
    h.fixture.detectChanges();
    expect(h.fixture.nativeElement.textContent).toContain("trace-actual");
    expect(h.fixture.nativeElement.textContent).toContain("<script>not executable</script>");
    expect(h.fixture.nativeElement.querySelector("img,script,iframe")).toBeNull();
  });
});
