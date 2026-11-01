import {
  Component,
  DestroyRef,
  Input,
  effect,
  inject,
  signal,
  untracked,
  type OnChanges,
} from "@angular/core";
import { LucideDownload, LucideRefreshCw } from "@lucide/angular";
import type { AssetView, AttachmentView } from "../shared/media-views";
import { Workspace } from "./workspace";

@Component({
  selector: "verified-attachment",
  standalone: true,
  imports: [LucideDownload, LucideRefreshCw],
  template: `
    @if (image()) {
      @if (url() && !imageError()) {
        <img
          class="attachment-image"
          [src]="url()"
          [alt]="reference.filename"
          (error)="imageError.set(true)"
        />
      } @else if (pending()) {
        <p class="muted" role="status">Loading image</p>
      }
      @if (imageError()) {
        <p class="validation" role="alert">
          Image could not be decoded. Verified bytes remain downloadable.
        </p>
      }
    }
    @if (error()) {
      <p class="validation" role="alert">{{ error() }}</p>
    }
    <button type="button" class="button" [disabled]="pending()" (click)="download()">
      <svg lucideDownload aria-hidden="true"></svg
      >{{ pending() ? "Loading attachment" : "Download " + reference.filename }}
    </button>
    @if (image() && error()) {
      <button
        type="button"
        class="icon-button"
        title="Retry image preview"
        aria-label="Retry image preview"
        (click)="load()"
      >
        <svg lucideRefreshCw aria-hidden="true"></svg>
      </button>
    }
  `,
})
export class VerifiedAttachmentComponent implements OnChanges {
  @Input({ required: true }) reference!: AttachmentView | AssetView;
  private readonly workspace = inject(Workspace);
  private readonly destroy = inject(DestroyRef);
  readonly url = signal("");
  readonly pending = signal(false);
  readonly error = signal("");
  readonly imageError = signal(false);
  private controller: AbortController | undefined;
  private sequence = 0;
  private signature = "";
  constructor() {
    effect(() => {
      this.workspace.fixture();
      if (this.reference) untracked(() => this.reset());
    });
    this.destroy.onDestroy(() => {
      this.sequence++;
      this.controller?.abort();
      this.revoke();
    });
  }
  ngOnChanges() {
    this.reset();
  }
  image() {
    return ["image/png", "image/jpeg"].includes(this.reference.mediaType);
  }
  private revoke() {
    if (this.url()) URL.revokeObjectURL(this.url());
    this.url.set("");
  }
  private reset() {
    const signature = JSON.stringify([this.workspace.fixture(), this.reference]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.sequence++;
    this.controller?.abort();
    this.revoke();
    this.pending.set(false);
    this.error.set("");
    this.imageError.set(false);
    if (this.image()) void this.load();
  }
  async load() {
    if (this.destroy.destroyed || this.pending()) return;
    const sequence = ++this.sequence;
    this.controller = new AbortController();
    this.pending.set(true);
    this.error.set("");
    const ref = this.reference;
    try {
      const reference =
        "verified" in ref
          ? {
              assetId: ref.assetId,
              contentId: ref.contentId,
              filename: ref.filename,
              mediaType: ref.mediaType,
              size: ref.verified!.size,
              sha256: ref.verified!.sha256,
            }
          : ref;
      const blob = await this.workspace.client.attachment(reference, this.controller.signal);
      if (sequence !== this.sequence || this.destroy.destroyed) return;
      this.revoke();
      this.url.set(URL.createObjectURL(blob));
    } catch {
      if (sequence === this.sequence && !this.controller.signal.aborted)
        this.error.set("Verified attachment could not be loaded.");
    } finally {
      if (sequence === this.sequence) this.pending.set(false);
    }
  }
  async download() {
    if (!this.url()) await this.load();
    if (!this.url() || this.destroy.destroyed) return;
    const anchor = document.createElement("a");
    anchor.href = this.url();
    anchor.download = this.reference.filename;
    anchor.click();
  }
}
