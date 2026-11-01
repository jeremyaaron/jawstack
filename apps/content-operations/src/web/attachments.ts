import { Component, Input, ChangeDetectorRef, DestroyRef, ElementRef, inject } from "@angular/core";
import { CommonModule } from "@angular/common";
import { LucideUpload, LucideTrash2, LucideX } from "@lucide/angular";
import { AttachmentSession } from "./attachment-session";
import { VerifiedAttachmentComponent } from "./verified-attachment";
import type { AssetView } from "../shared/media-views";

@Component({
  selector: "content-attachments",
  standalone: true,
  imports: [CommonModule, LucideUpload, LucideTrash2, LucideX, VerifiedAttachmentComponent],
  template: `
    <section class="media-section" aria-label="Attachments">
      <header class="section-heading"><h2>Attachments</h2></header>
      @if (session.error()) {
        <p class="validation" role="alert">{{ session.error() }}</p>
      }
      @if (session.editable()) {
        <label class="file-control"
          >Add attachment
          <input
            type="file"
            aria-label="Add attachment"
            accept="image/png,image/jpeg,application/pdf"
            [disabled]="session.pending() || !!session.file()"
            (change)="select($event)"
          />
        </label>
      }
      @if (session.file(); as file) {
        <div class="transfer-state" aria-live="polite">
          <p class="filename">
            {{ file.name }} <span class="muted">{{ file.size | number }} bytes</span>
          </p>
          @if (session.pending()) {
            <p role="status">
              {{
                session.transferring()
                  ? session.progress() === 100
                    ? "Verifying upload"
                    : "Uploading " + session.progress() + "%"
                  : "Checking attachment"
              }}
            </p>
            <progress
              max="100"
              [value]="session.progress()"
              aria-label="Upload progress"
            ></progress>
            @if (session.transferring()) {
              <button class="button" type="button" (click)="session.cancel()">
                <svg lucideX aria-hidden="true"></svg>Cancel upload
              </button>
            }
          } @else {
            <div class="actions">
              <button
                class="button primary"
                type="button"
                [disabled]="blocked || session.conflict()"
                (click)="upload()"
              >
                <svg lucideUpload aria-hidden="true"></svg
                >{{ session.target() ? "Retry upload" : "Upload attachment" }}
              </button>
              <button class="button" type="button" (click)="session.reset()">
                <svg lucideX aria-hidden="true"></svg>Discard selection
              </button>
            </div>
          }
        </div>
      }
      <ul class="attachment-list">
        @for (slot of session.row()?.state?.attachments; track slot.assetId) {
          <li class="attachment-item">
            <div class="section-heading">
              <strong class="filename">{{ slot.filename }}</strong
              ><span class="attachment-state" [attr.data-state]="slot.status">{{
                slot.status
              }}</span>
            </div>
            <p class="muted">{{ slot.mediaType }} · {{ slot.expectedSize | number }} bytes</p>
            @if (slot.status === "ready" && slot.verified) {
              <verified-attachment [reference]="slot" />
            }
            @if (slot.status === "pending") {
              <p class="muted">
                Awaiting verified bytes · expires {{ slot.uploadExpiresAt | date: "MMM d, HH:mm" }}
              </p>
              @if (session.editable() && !session.file()) {
                <label class="file-control"
                  >Retry {{ slot.filename
                  }}<input
                    type="file"
                    [attr.aria-label]="'Retry ' + slot.filename"
                    accept="image/png,image/jpeg,application/pdf"
                    [disabled]="blocked || session.pending()"
                    (change)="select($event, slot)"
                /></label>
              }
            }
            @if (session.editable() && (slot.status === "ready" || slot.status === "pending")) {
              <button
                type="button"
                class="icon-button"
                [title]="'Remove ' + slot.filename"
                [attr.aria-label]="'Remove ' + slot.filename"
                [disabled]="blocked || session.pending() || !!session.file() || session.conflict()"
                (click)="session.remove(slot)"
              >
                <svg lucideTrash2 aria-hidden="true"></svg>
              </button>
            }
          </li>
        } @empty {
          <li class="muted">No attachments</li>
        }
      </ul>
    </section>
  `,
})
export class AttachmentsComponent {
  @Input({ required: true }) session!: AttachmentSession;
  @Input() blocked = false;
  private readonly element: ElementRef<HTMLElement> = inject(ElementRef);
  private readonly change = inject(ChangeDetectorRef);
  private readonly destroy = inject(DestroyRef);
  async upload() {
    await this.session.upload();
    if (!this.destroy.destroyed && !this.session.file()) {
      this.change.detectChanges();
      this.element.nativeElement
        .querySelector<HTMLInputElement>('input[aria-label="Add attachment"]')
        ?.focus();
    }
  }
  select(event: Event, slot?: AssetView) {
    const input = event.target as HTMLInputElement;
    this.session.select(input.files?.[0], slot);
    input.value = "";
  }
}
