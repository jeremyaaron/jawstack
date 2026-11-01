import { CommonModule } from "@angular/common";
import { Component, DestroyRef, HostListener, effect, inject, signal } from "@angular/core";
import { ReactiveFormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterLink, type CanDeactivateFn } from "@angular/router";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { JsErrorPanelComponent, JsStatusBadgeComponent } from "@jawstack/angular";
import {
  LucideArrowLeft,
  LucideSave,
  LucideRefreshCw,
  LucideGitCompareArrows,
} from "@lucide/angular";
import { Workspace } from "./workspace";
import { DraftEditor, errorMessage } from "./draft-editor";

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
          <fieldset [disabled]="!editor.editable() || editor.pending()">
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
                [disabled]="editor.pending() || editor.conflict() || (id() && !editor.dirty())"
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
              <dd>{{ row.state.attachments.length }}</dd>
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
            <button class="button" [disabled]="editor.pending()" (click)="refresh()">
              <svg lucideRefreshCw aria-hidden="true"></svg>Refresh
            </button>
          }
        </aside>
      </div>
    }
  `,
})
export class ContentDetailComponent {
  readonly workspace = inject(Workspace);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  readonly editor = new DraftEditor(this.workspace.client, () => this.workspace.fixture());
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
    if (this.editor.dirty() || this.editor.pending()) event.preventDefault();
  }
  canLeave() {
    return (
      !this.editor.pending() && (!this.editor.dirty() || window.confirm("Discard unsaved changes?"))
    );
  }
  refresh() {
    if (this.canLeave()) void this.load();
  }
  async load() {
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
    } catch (error) {
      if (sequence === this.sequence && !this.request.signal.aborted)
        this.loadError.set(errorMessage(error));
    } finally {
      if (sequence === this.sequence) this.loading.set(false);
    }
  }
  async save() {
    const isNew = !this.id();
    const id = await this.editor.save();
    if (this.editor.validationField())
      document.getElementById(`content-${this.editor.validationField()}`)?.focus();
    if (id && isNew) await this.router.navigate(["/content", id]);
  }
  bytes() {
    return new TextEncoder().encode(this.editor.form.controls.body.value).length;
  }
}
export const draftGuard: CanDeactivateFn<ContentDetailComponent> = (component) =>
  component.canLeave();
