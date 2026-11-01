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
        useValue: { queryParamMap, paramMap: new BehaviorSubject(convertToParamMap(params)) },
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
});
