import { CommonModule } from "@angular/common";
import {
  Component,
  DestroyRef,
  EventEmitter,
  Input,
  Output,
  inject,
  signal,
  type OnChanges,
  type SimpleChanges,
} from "@angular/core";
import { LucideDownload, LucideSend, LucideRefreshCw } from "@lucide/angular";
import type { ContentResource } from "./client";
import type { PublicationView } from "../shared/media-views";
import { Workspace } from "./workspace";
import { EditorialAction } from "./editorial-action";
import { VisibilityPoll } from "./visibility-poll";
import { VerifiedAttachmentComponent } from "./verified-attachment";

@Component({
  selector: "content-publication",
  standalone: true,
  imports: [CommonModule, LucideDownload, LucideSend, LucideRefreshCw, VerifiedAttachmentComponent],
  template: `
    <section class="media-section" aria-label="Publication">
      <header class="section-heading">
        <h2>Publication</h2>
        @if (row.state.publication; as publication) {
          <span class="attachment-state" [attr.data-state]="publication.phase" role="status">{{
            publication.phase
          }}</span>
        }
      </header>
      @if (action.error() || error()) {
        <p class="validation" role="alert">{{ action.error() || error() }}</p>
      }
      @if (row.state.status === "approved") {
        @if (workspace.fixture().startsWith("editor")) {
          <button
            class="button primary"
            type="button"
            [disabled]="blocked || action.pending() || action.conflict() || awaiting()"
            (click)="publish()"
          >
            <svg lucideSend aria-hidden="true"></svg
            >{{ action.pending() ? "Requesting publication" : "Publish now" }}
          </button>
        } @else {
          <p class="muted">An editor can publish this approved snapshot.</p>
        }
      } @else if (!row.state.publication) {
        <p class="muted">No publication requested</p>
      }
      @if (awaiting() || row.state.status === "publishing") {
        <p class="muted">
          {{
            row.state.publication?.phase === "failed" || row.state.publication?.phase === "stalled"
              ? "Publication needs attention. Content remains locked."
              : "Publication is not yet committed. Content remains locked."
          }}
        </p>
      }
      @if (loading()) {
        <p role="status">Loading committed artifact</p>
      }
      @if (preview(); as view) {
        <section class="publication-preview" aria-label="Committed publication">
          <header class="section-heading">
            <h3>{{ view.artifact.content.title }}</h3>
            <a
              class="button"
              [href]="downloadUrl()"
              [download]="row.resourceId + '-publication.redacted.json'"
              ><svg lucideDownload aria-hidden="true"></svg>Download redacted JSON</a
            >
          </header>
          <p class="muted">Committed {{ view.completedAt | date: "MMM d, yyyy, HH:mm:ss" }}</p>
          <pre class="snapshot-body">{{ view.artifact.content.body }}</pre>
          <dl class="artifact-metadata">
            <dt>Stored artifact bytes</dt>
            <dd>{{ view.size | number }}</dd>
            <dt>Stored artifact SHA-256</dt>
            <dd class="digest">{{ view.sha256 }}</dd>
            <dt>Publication</dt>
            <dd class="digest">{{ view.artifact.publicationId }}</dd>
          </dl>
          <ul class="attachment-list">
            @for (asset of view.artifact.content.attachments; track asset.assetId) {
              <li class="attachment-item">
                <strong class="filename">{{ asset.filename }}</strong
                ><verified-attachment [reference]="asset" />
              </li>
            }
          </ul>
        </section>
      } @else if (committed() && !loading()) {
        <button class="button" type="button" (click)="loadPreview()">
          <svg lucideRefreshCw aria-hidden="true"></svg>Retry committed preview
        </button>
      }
    </section>
  `,
})
export class PublicationComponent implements OnChanges {
  @Input({ required: true }) row!: ContentResource;
  @Input() blocked = false;
  @Output() readonly changed = new EventEmitter<ContentResource>();
  @Output() readonly busy = new EventEmitter<boolean>();
  readonly workspace = inject(Workspace);
  private readonly destroy = inject(DestroyRef);
  readonly action = new EditorialAction(
    this.workspace.client,
    () => this.workspace.fixture(),
    "Content changed. Refresh before publishing; the approved snapshot has not been replaced.",
  );
  readonly preview = signal<PublicationView | undefined>(undefined);
  readonly loading = signal(false);
  readonly awaiting = signal(false);
  readonly error = signal("");
  readonly downloadUrl = signal("");
  private readonly poll = new VisibilityPoll(document);
  private controller: AbortController | undefined;
  private sequence = 0;
  constructor() {
    this.destroy.onDestroy(() => {
      this.sequence++;
      this.controller?.abort();
      this.poll.destroy();
      this.revoke();
    });
  }
  ngOnChanges(changes: SimpleChanges) {
    // Input changes caused only by another operation's busy state must not reset polling or intents.
    if (!changes["row"]) return;
    if (this.row.state.status !== "approved") this.awaiting.set(false);
    this.poll.stop();
    if (
      this.row.state.status === "publishing" &&
      ["queued", "running"].includes(this.row.state.publication!.phase)
    )
      this.watch();
    if (this.committed() && !this.preview() && !this.loading()) void this.loadPreview();
  }
  committed() {
    return (
      ["published", "archived"].includes(this.row.state.status) &&
      this.row.state.publication?.phase === "succeeded"
    );
  }
  private revoke() {
    if (this.downloadUrl()) URL.revokeObjectURL(this.downloadUrl());
    this.downloadUrl.set("");
  }
  private watch() {
    const id = this.row.resourceId;
    this.poll.start(async (signal) => {
      try {
        const row = await this.workspace.client.getContent(id, signal);
        if (signal.aborted || this.destroy.destroyed) return false;
        this.error.set("");
        if (row.version !== this.row.version) this.changed.emit(row);
        return (
          row.state.status === "publishing" &&
          ["queued", "running"].includes(row.state.publication!.phase)
        );
      } catch {
        if (!signal.aborted)
          this.error.set("Publication status could not be loaded. Retrying while visible.");
        return true;
      }
    });
  }
  async publish() {
    const row = this.row;
    const approval = row.state.approval;
    if (
      this.blocked ||
      this.action.pending() ||
      this.action.conflict() ||
      this.awaiting() ||
      row.state.status !== "approved" ||
      !approval ||
      !this.workspace.fixture().startsWith("editor")
    )
      return;
    this.busy.emit(true);
    try {
      const result = await this.action.run(
        "publishNow",
        {
          expectedVersion: row.version,
          reviewId: approval.reviewId,
          revisionId: approval.revisionId,
        },
        row.resourceId,
      );
      if (!result || this.destroy.destroyed) return;
      this.awaiting.set(true);
      try {
        const latest = await this.workspace.client.getContent(row.resourceId);
        if (!this.destroy.destroyed) this.changed.emit(latest);
      } catch {
        this.error.set("Publication requested. Latest status could not be loaded.");
        this.watch();
      }
    } finally {
      this.busy.emit(false);
    }
  }
  async loadPreview() {
    if (!this.committed() || this.destroy.destroyed) return;
    const sequence = ++this.sequence;
    this.controller?.abort();
    this.controller = new AbortController();
    this.loading.set(true);
    this.error.set("");
    try {
      const view = await this.workspace.client.publication(
        this.row.resourceId,
        this.controller.signal,
      );
      const publication = this.row.state.publication!;
      if (
        view.artifact.publicationId !== publication.intent.publicationId ||
        view.sha256 !== publication.artifact?.sha256 ||
        view.size !== publication.artifact.size
      )
        throw new Error("Committed metadata mismatch.");
      if (sequence !== this.sequence || this.destroy.destroyed) return;
      this.preview.set(view);
      this.revoke();
      this.downloadUrl.set(
        URL.createObjectURL(
          new Blob([JSON.stringify(view.artifact, null, 2) + "\n"], { type: "application/json" }),
        ),
      );
    } catch {
      if (sequence === this.sequence && !this.controller.signal.aborted)
        this.error.set("Committed artifact could not be verified or loaded.");
    } finally {
      if (sequence === this.sequence) this.loading.set(false);
    }
  }
}
