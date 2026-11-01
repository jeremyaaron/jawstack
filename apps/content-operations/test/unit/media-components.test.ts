// @vitest-environment jsdom
import "@angular/compiler";
import { signal, provideZonelessChangeDetection, type Type } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Workspace } from "../../src/web/workspace";
import { ContentOperationsClient, type ContentResource } from "../../src/web/client";
import { VerifiedAttachmentComponent } from "../../src/web/verified-attachment";
import { PublicationComponent } from "../../src/web/publication";
import { AttachmentsComponent } from "../../src/web/attachments";
import { AttachmentSession } from "../../src/web/attachment-session";
import type { AttachmentView, PublicationView } from "../../src/shared/media-views";
import { JawStackApiError } from "@jawstack/angular";

const id = "10000000-0000-4000-8000-000000000001";
const assetId = "10000000-0000-4000-8000-000000000002";
const reference: AttachmentView = {
  contentId: id,
  assetId,
  filename: "proof.png",
  mediaType: "image/png",
  size: 12,
  sha256: "a".repeat(64),
};
const approved = {
  resourceId: id,
  version: 3,
  state: {
    contentId: id,
    status: "approved",
    approval: { reviewId: id, revisionId: id },
    publication: null,
  },
} as unknown as ContentResource;
const published = {
  ...approved,
  version: 6,
  state: {
    ...approved.state,
    status: "published",
    publication: {
      intent: { publicationId: id },
      phase: "succeeded",
      artifact: { sha256: "a".repeat(64), size: 320 },
    },
  },
} as unknown as ContentResource;
const view: PublicationView = {
  artifact: {
    schemaVersion: 1,
    publicationId: id,
    contentId: id,
    requestedAt: "2026-10-31T12:00:00.000Z",
    approval: {
      reviewId: id,
      revisionId: id,
      approvedBy: "editor_1",
      approvedAt: "2026-10-31T11:00:00.000Z",
    },
    schedule: null,
    content: {
      revisionId: id,
      authorId: "author_1",
      title: "Stored title",
      body: "<script>Plain body, never HTML</script>",
      submittedAt: "2026-10-31T10:00:00.000Z",
      attachments: [],
    },
  },
  sha256: "a".repeat(64),
  size: 320,
  completedAt: "2026-10-31T12:00:01.000Z",
};
function setup<T>(component: Type<T>) {
  const workspace = {
    fixture: signal("editor_1" as const),
    client: new ContentOperationsClient({ fixture: () => "editor_1" }),
  };
  const fixture = TestBed.configureTestingModule({
    imports: [component],
    providers: [provideZonelessChangeDetection(), { provide: Workspace, useValue: workspace }],
  }).createComponent(component);
  return { fixture, client: workspace.client, component: fixture.componentInstance };
}
describe("verified media components", () => {
  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));
  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  function objectUrls() {
    const create = vi.fn(() => "blob:verified");
    const revoke = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = create;
        static revokeObjectURL = revoke;
      },
    );
    return { create, revoke };
  }
  it("renders only downloaded image bytes and revokes object URLs/requests on teardown", async () => {
    const urls = objectUrls();
    const read = vi
      .spyOn(ContentOperationsClient.prototype, "attachment")
      .mockResolvedValue(new Blob(["actual response bytes"], { type: "image/png" }));
    const h = setup(VerifiedAttachmentComponent);
    h.fixture.componentRef.setInput("reference", reference);
    h.fixture.detectChanges();
    await h.fixture.whenStable();
    h.fixture.detectChanges();
    expect(read).toHaveBeenCalledWith(reference, expect.any(AbortSignal));
    expect(h.fixture.nativeElement.querySelector("img").getAttribute("src")).toBe("blob:verified");
    expect(urls.create).toHaveBeenCalled();
    h.fixture.nativeElement.querySelector("img").dispatchEvent(new Event("error"));
    h.fixture.detectChanges();
    expect(h.fixture.nativeElement.querySelector("img")).toBeNull();
    expect(h.fixture.nativeElement.textContent).toContain("Verified bytes remain downloadable");
    h.fixture.destroy();
    expect(read.mock.calls.at(-1)![1]!.aborted).toBe(true);
    expect(urls.revoke).toHaveBeenCalledWith("blob:verified");
  });
  it("does not embed PDFs or show an unverified/failed image as a successful preview", async () => {
    objectUrls();
    const read = vi
      .spyOn(ContentOperationsClient.prototype, "attachment")
      .mockRejectedValue(new Error("private SDK body"));
    const h = setup(VerifiedAttachmentComponent);
    h.fixture.componentRef.setInput("reference", {
      ...reference,
      filename: "proof.pdf",
      mediaType: "application/pdf",
    });
    h.fixture.detectChanges();
    await h.fixture.whenStable();
    expect(read).not.toHaveBeenCalled();
    await h.component.download();
    h.fixture.detectChanges();
    expect(h.fixture.nativeElement.querySelector("iframe,object,embed,img")).toBeNull();
    expect(h.fixture.nativeElement.textContent).toContain("could not be loaded");
    expect(h.fixture.nativeElement.textContent).not.toContain("private SDK body");
  });
  it("renders authoritative pending state and accessible file controls, never a pending thumbnail", async () => {
    objectUrls();
    const h = setup(AttachmentsComponent);
    const row = {
      resourceId: id,
      version: 2,
      state: {
        authorId: "author_1",
        status: "draft",
        attachments: [
          {
            ...reference,
            status: "pending",
            verified: null,
            expectedSize: 12,
            uploadExpiresAt: "2027-01-01T12:00:00.000Z",
          },
        ],
      },
    } as unknown as ContentResource;
    const session = new AttachmentSession(
      h.client,
      () => "author_1",
      () => row,
      () => {},
      () => false,
    );
    h.fixture.componentRef.setInput("session", session);
    h.fixture.detectChanges();
    expect(
      h.fixture.nativeElement.querySelector('input[aria-label="Add attachment"]'),
    ).not.toBeNull();
    expect(h.fixture.nativeElement.querySelector("img,verified-attachment")).toBeNull();
    expect(h.fixture.nativeElement.textContent).toContain("Awaiting verified bytes");
    session.select(new File(["bytes"], "<unsafe>.png", { type: "image/png" }));
    h.fixture.detectChanges();
    expect(h.fixture.nativeElement.querySelector('[role="alert"]').textContent).toContain(
      "safe filename",
    );
    session.destroy();
  });
  it("keeps publish intent on a lost response, polls committed authority, exports redacted text, and stops on teardown", async () => {
    objectUrls();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    const h = setup(PublicationComponent);
    h.fixture.componentRef.setInput("row", approved);
    h.fixture.detectChanges();
    const mutate = vi
      .spyOn(h.client, "mutate")
      .mockRejectedValueOnce(new TypeError("lost"))
      .mockResolvedValue({ resourceId: id, version: 4 });
    vi.spyOn(h.client, "getContent")
      .mockRejectedValueOnce(new Error("read lost"))
      .mockResolvedValue(published);
    vi.spyOn(h.client, "publication").mockResolvedValue(view);
    h.component.changed.subscribe((row) => h.fixture.componentRef.setInput("row", row));
    await h.component.publish();
    expect(h.component.action.error()).toContain("preserved");
    vi.useFakeTimers();
    await h.component.publish();
    expect(mutate.mock.calls[0]![3]).toBe(mutate.mock.calls[1]![3]);
    expect(h.component.awaiting()).toBe(true);
    h.fixture.componentRef.setInput("blocked", true);
    h.fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(2000);
    h.fixture.detectChanges();
    await h.component.loadPreview();
    h.fixture.detectChanges();
    expect(h.fixture.nativeElement.textContent).toContain("Stored title");
    expect(h.fixture.nativeElement.textContent).toContain(view.artifact.content.body);
    expect(h.fixture.nativeElement.querySelector("script")).toBeNull();
    expect(h.fixture.nativeElement.querySelector("a[download]").textContent).toContain(
      "redacted JSON",
    );
    expect(h.fixture.nativeElement.textContent).toContain("Stored artifact SHA-256");
    h.fixture.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains a conflicted publication base and never renders a preview for failed verification", async () => {
    objectUrls();
    const h = setup(PublicationComponent);
    h.fixture.componentRef.setInput("row", approved);
    h.fixture.detectChanges();
    const mutate = vi
      .spyOn(h.client, "mutate")
      .mockRejectedValue(new JawStackApiError("stale", { status: 409, code: "resource.conflict" }));
    await h.component.publish();
    await h.component.publish();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(h.component.row.version).toBe(3);
    h.fixture.componentRef.setInput("row", published);
    vi.spyOn(h.client, "publication").mockResolvedValue({ ...view, sha256: "b".repeat(64) });
    h.fixture.detectChanges();
    await h.component.loadPreview();
    h.fixture.detectChanges();
    expect(h.fixture.nativeElement.querySelector(".publication-preview")).toBeNull();
    expect(h.component.error()).toContain("could not be verified");
  });
});
