// @vitest-environment jsdom
import "@angular/compiler";
import { signal, provideZonelessChangeDetection, type Type } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { ActivatedRoute, convertToParamMap, provideRouter } from "@angular/router";
import { BehaviorSubject } from "rxjs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ContentListComponent } from "../../src/web/content-list";
import { ContentDetailComponent } from "../../src/web/content-detail";
import { Workspace } from "../../src/web/workspace";
import { ContentOperationsClient, type ContentResource } from "../../src/web/client";
import { ReviewDetailComponent } from "../../src/web/review-detail";
import { ReviewListComponent } from "../../src/web/review-list";
import { ActivityComponent } from "../../src/web/activity";
import { AppComponent } from "../../src/web/app";
import { JawStackApiError } from "@jawstack/angular";
import type { ReviewView } from "../../src/shared/review-views";

const id = "10000000-0000-4000-8000-000000000001";
function setup<T>(
  component: Type<T>,
  query: Record<string, string> = {},
  params: Record<string, string> = {},
) {
  const client = new ContentOperationsClient({ fixture: () => "author_1" });
  const queryParamMap = new BehaviorSubject(convertToParamMap(query));
  const workspace = {
    fixture: signal("author_1"),
    client,
    listUrl: "/content",
    reviewsUrl: "/reviews",
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
  return { fixture, client, workspace, queryParamMap };
}
describe("content workbench components", () => {
  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });
  it("renders persisted fixture selection and restores it when dirty-work guards reject a change", async () => {
    localStorage.setItem("content-ops-fixture", "editor_2");
    const workspace = new Workspace();
    vi.spyOn(workspace.client, "request").mockResolvedValue({
      runtime: "memory",
      processing: "managed",
    });
    const fixture = TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: Workspace, useValue: workspace },
      ],
    }).createComponent(AppComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const select = fixture.nativeElement.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("editor_2");
    workspace.canLeave = () => false;
    select.value = "author_2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    fixture.detectChanges();
    expect(select.value).toBe("editor_2");
    expect(workspace.fixture()).toBe("editor_2");
    expect(localStorage.getItem("content-ops-fixture")).toBe("editor_2");
    localStorage.removeItem("content-ops-fixture");
  });
  it("renders loading, empty continued pages and load errors without inventing end-of-list", async () => {
    const network = vi
      .spyOn(ContentOperationsClient.prototype, "content")
      .mockResolvedValue({ items: [], nextCursor: "more" });
    const h = setup(ContentListComponent);
    h.fixture.detectChanges();
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    expect(h.fixture.nativeElement.textContent).toContain("No matches on this page");
    expect(h.fixture.nativeElement.textContent).toContain("Load more");
    network.mockRejectedValue(new Error("Unavailable"));
    h.fixture.componentInstance.reload();
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    expect(h.fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      "Unavailable",
    );
  });
  it("does not fetch invalid URL filters and renders actual safe metadata rows", async () => {
    const network = vi.spyOn(ContentOperationsClient.prototype, "content").mockResolvedValue({
      items: [
        {
          projectionName: "contentItem.list",
          itemId: id,
          sort: id,
          data: {
            title: "Actual title",
            status: "draft",
            authorId: "author_1",
            revisionId: id,
            version: 3,
            createdAt: "2026-10-31T12:00:00.000Z",
            updatedAt: "2026-10-31T12:00:00.000Z",
          },
        },
      ],
    });
    const h = setup(ContentListComponent, { limit: "999" });
    h.fixture.detectChanges();
    await h.fixture.whenStable();
    expect(network).not.toHaveBeenCalled();
    expect(h.fixture.nativeElement.textContent).toContain("filters are invalid");
    h.queryParamMap.next(convertToParamMap({ status: "draft" }));
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    expect(h.fixture.nativeElement.textContent).toContain("Actual title");
    expect(h.fixture.nativeElement.textContent).toContain("Version 3");
  });
  it("guards pending/dirty edits and marks unavailable details as errors instead of new drafts", async () => {
    vi.spyOn(ContentOperationsClient.prototype, "getContent").mockRejectedValue(
      new Error("Offline"),
    );
    const h = setup(ContentDetailComponent, {}, { id });
    h.fixture.detectChanges();
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    expect(h.fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      "could not complete",
    );
    expect(h.fixture.nativeElement.querySelector("form")).toBeNull();
    const component = h.fixture.componentInstance;
    component.editor.form.controls.body.setValue("字");
    expect(component.bytes()).toBe(3);
    component.editor.accept();
    expect(component.bytes()).toBe(0);
    component.editor.dirty.set(true);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    expect(component.canLeave()).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    component.editor.pending.set(true);
    expect(component.canLeave()).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    const event = new Event("beforeunload", { cancelable: true });
    component.beforeUnload(event as BeforeUnloadEvent);
    expect(event.defaultPrevented).toBe(true);
  });
  it("renders a read-only foreign draft without offering save commands", async () => {
    vi.spyOn(ContentOperationsClient.prototype, "getContent").mockResolvedValue({
      resourceId: id,
      resourceType: "contentItem",
      version: 2,
      updatedAt: "2026-10-31T12:00:00.000Z",
      state: {
        title: "Foreign",
        body: "Read-only text",
        authorId: "author_2",
        status: "draft",
        attachments: [],
      },
    } as unknown as ContentResource);
    const h = setup(ContentDetailComponent, {}, { id });
    h.fixture.detectChanges();
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    expect(h.fixture.nativeElement.querySelector("fieldset").disabled).toBe(true);
    expect(h.fixture.nativeElement.textContent).toContain("Only the owning author");
    expect(h.fixture.nativeElement.textContent).not.toContain("Save draft");
  });
  it("renders pending authoritative snapshots and dispatches approval through the actual reactive form", async () => {
    const review: ReviewView = {
      reviewId: id,
      contentId: id,
      assignedEditorId: "editor_2",
      dueAt: "2026-11-02T12:00:00.000Z",
      lastReminderDay: null,
      status: "pending",
      sourceVersion: 2,
      decision: null,
      submitted: {
        contentId: id,
        revisionId: id,
        authorId: "author_1",
        title: "Frozen title",
        body: "<b>Plain immutable body</b>",
        submittedAt: "2026-11-01T12:00:00.000Z",
        attachments: [],
      },
    };
    vi.spyOn(ContentOperationsClient.prototype, "getReview").mockRejectedValue(
      new JawStackApiError("Pending", { status: 404, code: "resource.not_found" }),
    );
    vi.spyOn(ContentOperationsClient.prototype, "getContent").mockResolvedValue({
      resourceId: id,
      version: 2,
      state: {
        contentId: id,
        title: "Frozen title",
        body: "<b>Plain immutable body</b>",
        revisionId: id,
        status: "inReview",
        review,
        attachments: [],
      },
    } as unknown as ContentResource);
    vi.spyOn(ContentOperationsClient.prototype, "activityPage").mockResolvedValue({ items: [] });
    const mutate = vi
      .spyOn(ContentOperationsClient.prototype, "mutate")
      .mockResolvedValue({ resourceId: id, version: 3 });
    const h = setup(ReviewDetailComponent, { contentId: id }, { id });
    h.fixture.detectChanges();
    await h.fixture.componentInstance.load();
    h.fixture.detectChanges();
    expect(h.fixture.nativeElement.textContent).toContain("Review read model pending");
    expect(h.fixture.nativeElement.textContent).toContain("Only editors");
    expect(h.fixture.nativeElement.querySelector(".submitted-snapshot b")).toBeNull();
    h.workspace.fixture.set("editor_1");
    h.fixture.detectChanges();
    await h.fixture.componentInstance.load();
    h.fixture.detectChanges();
    h.fixture.componentInstance.session.note.setValue("Approval note");
    h.fixture.detectChanges();
    const event = new Event("submit", { bubbles: true, cancelable: true });
    h.fixture.nativeElement.querySelector("form").dispatchEvent(event);
    await h.fixture.whenStable();
    expect(event.defaultPrevented).toBe(true);
    expect(mutate).toHaveBeenCalledWith(
      "approve",
      { expectedVersion: 2, reviewId: id, revisionId: id, note: "Approval note" },
      id,
      expect.any(String),
    );
  });
  it("shows empty continued review pages and rejects invalid filter references before fetching", async () => {
    const fetch = vi
      .spyOn(ContentOperationsClient.prototype, "reviews")
      .mockResolvedValue({ items: [], nextCursor: "continue" });
    const h = setup(ReviewListComponent, { contentId: "not-a-uuid" });
    h.fixture.detectChanges();
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    expect(fetch).not.toHaveBeenCalled();
    h.queryParamMap.next(convertToParamMap({ contentId: id, status: "all" }));
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    expect(fetch).toHaveBeenCalled();
    expect(h.fixture.nativeElement.textContent).toContain("No matches on this page");
    expect(h.fixture.nativeElement.textContent).toContain("Load more reviews");
  });
  it("paginates real activity DTOs without replacing history, and renders recoverable errors", async () => {
    const row = {
      activityId: "a-1",
      resourceType: "contentItem" as const,
      resourceId: id,
      activityType: "created",
      title: "Created draft",
      correlationId: "trace-1",
      occurredAt: "2026-10-31T12:00:00.000Z",
    };
    const fetch = vi
      .spyOn(ContentOperationsClient.prototype, "activityPage")
      .mockResolvedValueOnce({ items: [row], nextCursor: "next" })
      .mockResolvedValueOnce({
        items: [{ ...row, activityId: "a-2", title: "Submitted for review" }],
      });
    const h = setup(ActivityComponent);
    h.fixture.componentRef.setInput("resourceId", id);
    h.fixture.componentRef.setInput("contentId", id);
    h.fixture.detectChanges();
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    await h.fixture.componentInstance.load(true);
    h.fixture.detectChanges();
    expect(h.fixture.nativeElement.textContent).toContain("Created draft");
    expect(h.fixture.nativeElement.textContent).toContain("Submitted for review");
    expect(fetch.mock.calls[1]![2]).toEqual({ limit: 5, cursor: "next" });
    fetch.mockRejectedValue(new Error("private dependency text"));
    await h.fixture.componentInstance.load(false);
    h.fixture.detectChanges();
    expect(h.fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      "Activity could not be loaded",
    );
    expect(h.fixture.nativeElement.textContent).not.toContain("private dependency");
  });
});
