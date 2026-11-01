import { CommonModule } from "@angular/common";
import {
  Component,
  ChangeDetectorRef,
  DestroyRef,
  HostListener,
  effect,
  inject,
  signal,
} from "@angular/core";
import { FormControl, FormGroup, ReactiveFormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterLink, type CanDeactivateFn } from "@angular/router";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { JsErrorPanelComponent, JsStatusBadgeComponent } from "@jawstack/angular";
import {
  LucideArrowLeft,
  LucideSave,
  LucideRefreshCw,
  LucideGitCompareArrows,
  LucideSend,
  LucideUndo2,
} from "@lucide/angular";
import { Workspace } from "./workspace";
import { DraftEditor, errorMessage } from "./draft-editor";
import { EditorialAction } from "./editorial-action";
import { ActivityComponent } from "./activity";
import { AttachmentSession } from "./attachment-session";
import { AttachmentsComponent } from "./attachments";
import { PublicationComponent } from "./publication";
import { editorIds } from "../shared/identities";
import { localTimeToUtc } from "../shared/time";
import { submitInput } from "../shared/contracts";

@Component({
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterLink,
    JsErrorPanelComponent,
    JsStatusBadgeComponent,
    LucideArrowLeft,
    LucideSave,
    LucideRefreshCw,
    LucideGitCompareArrows,
    LucideSend,
    LucideUndo2,
    ActivityComponent,
    AttachmentsComponent,
    PublicationComponent,
  ],
  template: `
    <a class="back-link" aria-label="Back to content" [routerLink]="backLink()"
      ><svg lucideArrowLeft aria-hidden="true"></svg>Content</a
    >
    @if (loading()) {
      <div class="empty-state" role="status">
        <span class="spinner"></span>
        <h2>Loading content</h2>
      </div>
    } @else if (loadError()) {
      <js-error-panel title="Content unavailable" [message]="loadError()" /><button
        class="button"
        (click)="load()"
      >
        Try again
      </button>
    } @else {
      <section class="page-heading editor-heading">
        <div>
          <p class="eyebrow">{{ id() ? "CONTENT ITEM" : "NEW CONTENT" }}</p>
          <h1>{{ editor.resource()?.state?.title ?? "New content" }}</h1>
        </div>
        <div class="save-state" aria-live="polite">
          {{ editor.pending() ? "Saving" : editor.dirty() ? "Unsaved changes" : editor.saved()
          }}<span class="status-dot" [class.unsaved]="editor.dirty()"></span>
        </div>
      </section>
      @if (editor.error()) {
        <js-error-panel
          [title]="editor.conflict() ? 'Version conflict' : 'Save failed'"
          [message]="editor.error()"
        />
      }
      @if (editor.conflict()) {
        <div class="conflict-actions">
          <button class="button" [disabled]="editor.pending()" (click)="editor.compare()">
            <svg lucideGitCompareArrows aria-hidden="true"></svg>Compare latest
          </button>
        </div>
      }
      @if (editor.latest(); as latest) {
        <section class="comparison">
          <h2>Server version {{ latest.version }}</h2>
          <h3>{{ latest.state.title }}</h3>
          <pre>{{ latest.state.body }}</pre>
          <div class="actions">
            <button class="button" (click)="editor.useServer()">Use server draft</button
            ><button
              class="button"
              [disabled]="latest.state.status !== 'draft'"
              (click)="editor.keepLocal()"
            >
              Keep local draft
            </button>
          </div>
        </section>
      }
      <div class="editor-layout">
        <form class="draft-form" [formGroup]="editor.form" (ngSubmit)="save()">
          <fieldset [disabled]="!editor.editable() || mutationPending()">
            <label for="content-title">Title</label
            ><input
              id="content-title"
              formControlName="title"
              maxlength="160"
              autocomplete="off"
              [attr.aria-invalid]="editor.validationField() === 'title' ? true : null"
              [attr.aria-describedby]="editor.validation() ? 'draft-validation' : null"
            />
            <div class="field-heading">
              <label for="content-body">Body</label><span>Plain text</span>
            </div>
            <textarea
              id="content-body"
              formControlName="body"
              spellcheck="true"
              [attr.aria-invalid]="editor.validationField() === 'body' ? true : null"
              [attr.aria-describedby]="editor.validation() ? 'draft-validation' : null"
            ></textarea>
          </fieldset>
          @if (editor.validation()) {
            <p id="draft-validation" class="validation" role="alert">{{ editor.validation() }}</p>
          }
          <div class="editor-footer">
            <span class="muted">{{ bytes() }} / 32,768 bytes</span>
            @if (editor.editable()) {
              <button
                type="submit"
                class="button primary"
                [disabled]="
                  editor.pending() ||
                  action.pending() ||
                  attachments.pending() ||
                  publicationBusy() ||
                  editor.conflict() ||
                  (id() && !editor.dirty())
                "
              >
                <svg lucideSave aria-hidden="true"></svg
                >{{ editor.pending() ? "Saving" : id() ? "Save draft" : "Create content" }}
              </button>
            }
          </div>
        </form>
        <aside class="item-properties">
          <h2>Details</h2>
          <dl>
            <dt>Status</dt>
            <dd><js-status-badge [value]="editor.resource()?.state?.status ?? 'draft'" /></dd>
            <dt>Author</dt>
            <dd>
              {{ (editor.resource()?.state?.authorId ?? workspace.fixture()).replace("_", " ") }}
            </dd>
            @if (editor.resource(); as row) {
              <dt>Version</dt>
              <dd>{{ row.version }}</dd>
              <dt>Updated</dt>
              <dd>{{ row.updatedAt | date: "MMM d, yyyy, HH:mm" }}</dd>
              <dt>Attachments</dt>
              <dd>{{ row.state.attachments.filter(activeAttachment).length }}</dd>
            }
          </dl>
          @if (!editor.editable()) {
            <p class="permission-state">
              {{
                editor.resource()?.state?.status !== "draft"
                  ? "Read-only · " + statusText()
                  : "Only the owning author or an editor can edit this draft."
              }}
            </p>
          }
          @if (id()) {
            <button class="button" [disabled]="mutationPending()" (click)="refresh()">
              <svg lucideRefreshCw aria-hidden="true"></svg>Refresh
            </button>
          }
        </aside>
      </div>
      @if (editor.resource(); as row) {
        <content-attachments
          [session]="attachments"
          [blocked]="
            editor.dirty() ||
            editor.pending() ||
            editor.conflict() ||
            action.pending() ||
            publicationBusy()
          "
        />
        <section class="review-section" aria-label="Review workflow">
          <header class="section-heading">
            <h2>Review</h2>
            <a
              class="inline-link"
              routerLink="/reviews"
              [queryParams]="{ contentId: row.resourceId, status: 'all' }"
              >Review history</a
            >
          </header>
          @if (action.error()) {
            <js-error-panel title="Review action failed" [message]="action.error()" />
          }
          @if (submissionError()) {
            <p class="validation" role="alert">{{ submissionError() }}</p>
          }
          @if (row.state.review; as review) {
            <div class="review-summary">
              <js-status-badge [value]="review.status" /><span>{{
                review.assignedEditorId.replace("_", " ")
              }}</span
              ><time [dateTime]="review.dueAt"
                >Due {{ review.dueAt | date: "MMM d, yyyy, HH:mm" : "UTC" }} UTC</time
              ><a
                class="inline-link"
                [routerLink]="['/reviews', review.reviewId]"
                [queryParams]="{ contentId: row.resourceId }"
                id="open-review"
                >Open review</a
              >
            </div>
            @if (review.decision) {
              <blockquote class="decision-note">
                {{ review.decision.note ?? "Review superseded" }}
                <footer>
                  {{ review.decision.actorId.replace("_", " ") }} ·
                  {{ review.decision.at | date: "MMM d, HH:mm" }}
                </footer>
              </blockquote>
            }
          }
          @if (editor.editable()) {
            <form class="submission-form" [formGroup]="submission" (ngSubmit)="submitReview()">
              <fieldset
                [disabled]="
                  editor.dirty() || mutationPending() || action.conflict() || !!attachments.file()
                "
              >
                <label
                  >Assigned editor<select
                    aria-label="Assigned editor"
                    formControlName="assignedEditorId"
                  >
                    @for (editorId of editors; track editorId) {
                      <option [value]="editorId">{{ editorId.replace("_", " ") }}</option>
                    }
                  </select></label
                ><label
                  >Review due (UTC)<input
                    aria-label="Review due (UTC)"
                    type="datetime-local"
                    formControlName="dueAt"
                    required /></label
                ><button class="button primary" type="submit">
                  <svg lucideSend aria-hidden="true"></svg
                  >{{ action.pending() ? "Submitting" : "Submit for review" }}
                </button>
              </fieldset>
              @if (editor.dirty()) {
                <p class="muted">Draft has unsaved changes</p>
              }
            </form>
          } @else if (canReopen()) {
            <div class="actions">
              <button
                class="button"
                [disabled]="mutationPending() || action.conflict()"
                (click)="reopen()"
              >
                <svg lucideUndo2 aria-hidden="true"></svg>Reopen draft
              </button>
            </div>
          }
        </section>
        <content-publication
          [row]="row"
          [blocked]="editor.dirty() || mutationPending() || !!attachments.file()"
          (changed)="editor.accept($event)"
          (busy)="publicationBusy.set($event)"
        />
        <content-activity
          [resourceId]="row.resourceId"
          [contentId]="row.resourceId"
          [version]="row.version"
        />
      }
    }
  `,
})
export class ContentDetailComponent {
  readonly workspace = inject(Workspace);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  private readonly change = inject(ChangeDetectorRef);
  readonly editor = new DraftEditor(this.workspace.client, () => this.workspace.fixture());
  readonly action = new EditorialAction(this.workspace.client, () => this.workspace.fixture());
  readonly publicationBusy = signal(false);
  readonly attachments = new AttachmentSession(
    this.workspace.client,
    () => this.workspace.fixture(),
    () => this.editor.resource(),
    (row) => this.editor.accept(row),
    () =>
      this.editor.dirty() ||
      this.editor.pending() ||
      this.editor.conflict() ||
      this.action.pending() ||
      this.publicationBusy(),
  );
  readonly activeAttachment = (slot: { status: string }) =>
    ["pending", "ready"].includes(slot.status);
  mutationPending() {
    return (
      this.editor.pending() ||
      this.action.pending() ||
      this.attachments.pending() ||
      this.publicationBusy()
    );
  }
  readonly editors = editorIds;
  readonly submission = new FormGroup({
    assignedEditorId: new FormControl("editor_1", { nonNullable: true }),
    dueAt: new FormControl(this.defaultDue(), { nonNullable: true }),
  });
  readonly submissionError = signal("");
  readonly id = signal<string | undefined>(undefined);
  readonly loading = signal(false);
  readonly loadError = signal("");
  private sequence = 0;
  private request: AbortController | undefined;
  constructor() {
    this.workspace.canLeave = () => this.canLeave();
    this.route.paramMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      this.id.set(params.get("id") ?? undefined);
      void this.load();
    });
    effect(() => {
      this.workspace.fixture();
      void this.load();
    });
    this.destroy.onDestroy(() => {
      this.sequence++;
      this.request?.abort();
      this.editor.destroy();
      this.attachments.destroy();
      this.workspace.canLeave = () => true;
    });
  }
  statusText() {
    return this.editor
      .resource()
      ?.state.status.replace(/([A-Z])/g, " $1")
      .toLowerCase();
  }
  backLink() {
    return this.router.parseUrl(this.workspace.listUrl);
  }
  @HostListener("window:beforeunload", ["$event"])
  beforeUnload(event: BeforeUnloadEvent) {
    if (
      this.editor.dirty() ||
      this.editor.pending() ||
      this.action.pending() ||
      this.attachments.pending() ||
      !!this.attachments.file() ||
      this.publicationBusy() ||
      this.submission.dirty
    )
      event.preventDefault();
  }
  canLeave() {
    return (
      !this.mutationPending() &&
      (!(this.editor.dirty() || this.submission.dirty || this.attachments.file()) ||
        window.confirm("Discard unsaved changes?"))
    );
  }
  refresh() {
    if (this.canLeave()) void this.load();
  }
  async load() {
    if (this.destroy.destroyed) return;
    const sequence = ++this.sequence;
    this.request?.abort();
    this.request = new AbortController();
    this.loadError.set("");
    this.loading.set(true);
    try {
      const row = this.id()
        ? await this.workspace.client.getContent(this.id()!, this.request.signal)
        : undefined;
      if (sequence !== this.sequence) return;
      this.editor.accept(row);
      this.attachments.reset();
      this.action.reset();
      this.submission.reset({ assignedEditorId: "editor_1", dueAt: this.defaultDue() });
      this.submissionError.set("");
    } catch (error) {
      if (sequence === this.sequence && !this.request.signal.aborted)
        this.loadError.set(errorMessage(error));
    } finally {
      if (sequence === this.sequence) this.loading.set(false);
    }
  }
  async save() {
    if (this.action.pending() || this.attachments.pending() || this.publicationBusy()) return;
    const isNew = !this.id();
    const id = await this.editor.save();
    if (this.editor.validationField())
      document.getElementById(`content-${this.editor.validationField()}`)?.focus();
    if (id && isNew) await this.router.navigate(["/content", id]);
  }
  bytes() {
    return new TextEncoder().encode(this.editor.form.controls.body.value).length;
  }
  defaultDue() {
    return new Date(Date.now() + 86_400_000).toISOString().slice(0, 16);
  }
  canReopen() {
    const row = this.editor.resource();
    return (
      !!row &&
      ["inReview", "approved"].includes(row.state.status) &&
      (row.state.authorId === this.workspace.fixture() ||
        this.workspace.fixture().startsWith("editor"))
    );
  }
  async submitReview() {
    const row = this.editor.resource();
    if (
      !row ||
      this.editor.dirty() ||
      this.mutationPending() ||
      this.attachments.file() ||
      !this.editor.editable()
    )
      return;
    this.submissionError.set("");
    let input;
    try {
      const value = this.submission.getRawValue();
      input = submitInput.parse({
        expectedVersion: row.version,
        assignedEditorId: value.assignedEditorId,
        dueAt: localTimeToUtc(value.dueAt, "UTC"),
      });
      if (Date.parse(input.dueAt) <= Date.now()) throw new Error();
    } catch {
      this.submissionError.set("Select an editor and a future review due time in UTC.");
      return;
    }
    if (await this.action.run("submit", input, row.resourceId)) {
      this.submission.markAsPristine();
      await this.load();
      this.focusResult("open-review");
    }
  }
  async reopen() {
    const row = this.editor.resource();
    if (
      row &&
      !this.mutationPending() &&
      this.canReopen() &&
      (await this.action.run("reopenDraft", { expectedVersion: row.version }, row.resourceId))
    ) {
      await this.load();
      this.focusResult("content-title");
    }
  }
  private focusResult(id: string) {
    if (!this.destroy.destroyed) {
      this.change.detectChanges();
      document.getElementById(id)?.focus();
    }
  }
}
export const draftGuard: CanDeactivateFn<ContentDetailComponent> = (component) =>
  component.canLeave();
