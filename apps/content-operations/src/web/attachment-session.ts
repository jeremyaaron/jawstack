import { signal } from "@angular/core";
import { JawStackApiError } from "@jawstack/angular";
import { registerAssetInput } from "../shared/assets";
import type { AssetView } from "../shared/media-views";
import type { FixtureId } from "../shared/identities";
import type { ContentOperationsClient, ContentResource, CommandInput } from "./client";

export class AttachmentSession {
  readonly file = signal<File | undefined>(undefined);
  readonly target = signal<string | undefined>(undefined);
  readonly pending = signal(false);
  readonly transferring = signal(false);
  readonly progress = signal(0);
  readonly error = signal("");
  readonly conflict = signal(false);
  private intent:
    | { key: string; input: CommandInput<"registerAsset">; contentId: string; actor: FixtureId }
    | undefined;
  private removal: { assetId: string; version: number; key: string } | undefined;
  private transfer: AbortController | undefined;
  private destroyed = false;
  constructor(
    private readonly client: ContentOperationsClient,
    private readonly fixture: () => FixtureId,
    readonly row: () => ContentResource | undefined,
    private readonly accept: (row: ContentResource) => void,
    private readonly blocked: () => boolean,
  ) {}
  editable() {
    const row = this.row();
    return (
      !!row &&
      row.state.status === "draft" &&
      (row.state.authorId === this.fixture() || this.fixture().startsWith("editor"))
    );
  }
  select(file?: File, slot?: AssetView) {
    if (this.pending() || !this.editable() || this.file()) return;
    this.error.set("");
    if (!file) return;
    const parsed = registerAssetInput.safeParse({
      expectedVersion: this.row()!.version,
      filename: file.name,
      mediaType: file.type,
      expectedSize: file.size,
    });
    if (!parsed.success) {
      this.error.set("Choose a nonempty PNG, JPEG, or PDF up to 10 MiB with a safe filename.");
      return;
    }
    if (
      slot &&
      (slot.status !== "pending" ||
        slot.filename !== file.name ||
        slot.mediaType !== file.type ||
        slot.expectedSize !== file.size)
    ) {
      this.error.set("Retry requires the registered filename, media type, and byte size.");
      return;
    }
    if (slot && Date.parse(slot.uploadExpiresAt) <= Date.now()) {
      this.error.set(
        "The upload deadline has passed. Remove the slot before registering a new attachment.",
      );
      return;
    }
    this.file.set(file);
    this.target.set(slot?.assetId);
    this.conflict.set(false);
    this.intent = undefined;
  }
  reset() {
    if (this.pending()) return;
    this.file.set(undefined);
    this.target.set(undefined);
    this.intent = undefined;
    this.removal = undefined;
    this.error.set("");
    this.conflict.set(false);
    this.progress.set(0);
  }
  cancel() {
    this.transfer?.abort();
  }
  destroy() {
    this.destroyed = true;
    this.cancel();
  }
  async upload() {
    const row = this.row();
    const file = this.file();
    if (!row || !file || this.pending() || this.blocked() || this.conflict() || !this.editable())
      return;
    this.pending.set(true);
    this.error.set("");
    this.progress.set(0);
    try {
      if (!this.target()) {
        this.intent ??= {
          key: crypto.randomUUID(),
          actor: this.fixture(),
          contentId: row.resourceId,
          input: {
            expectedVersion: row.version,
            filename: file.name,
            mediaType: registerAssetInput.shape.mediaType.parse(file.type),
            expectedSize: file.size,
          },
        };
        if (this.intent.actor !== this.fixture() || this.intent.contentId !== row.resourceId)
          throw new Error("Upload identity changed.");
        const result = await this.client.mutate(
          "registerAsset",
          this.intent.input,
          row.resourceId,
          this.intent.key,
        );
        if (!result.assetId) throw new Error("Registration did not return an attachment.");
        this.target.set(result.assetId);
      }
      if (this.destroyed) return;
      this.transfer = new AbortController();
      const registered = await this.client.getContent(row.resourceId, this.transfer.signal);
      if (this.destroyed) return;
      this.accept(registered);
      this.transferring.set(true);
      await this.client.upload(row.resourceId, this.target()!, file, this.transfer.signal, (p) =>
        this.progress.set(p),
      );
      this.transferring.set(false);
      const completed = await this.client.getContent(row.resourceId, this.transfer.signal);
      if (this.destroyed) return;
      this.accept(completed);
      if (
        !completed.state.attachments.some(
          (slot) => slot.assetId === this.target() && slot.status === "ready" && slot.verified,
        )
      )
        throw new Error("The attachment is not ready on the content item.");
      this.file.set(undefined);
      this.target.set(undefined);
      this.intent = undefined;
    } catch (error) {
      if (!this.destroyed) {
        this.conflict.set(error instanceof JawStackApiError && error.status === 409);
        this.error.set(
          this.conflict()
            ? "Content changed. The selected file is preserved; refresh before changing attachments."
            : error instanceof JawStackApiError && error.status === 403
              ? "This identity cannot upload this attachment."
              : error instanceof JawStackApiError && error.status >= 400 && error.status < 500
                ? `Upload rejected: ${error.message} The selected file is preserved.`
                : "Upload did not complete. The selected file is preserved; retry the same bytes or discard the selection.",
        );
      }
    } finally {
      this.pending.set(false);
      this.transferring.set(false);
      this.transfer = undefined;
    }
  }
  async remove(slot: AssetView) {
    const row = this.row();
    if (
      !row ||
      this.pending() ||
      this.file() ||
      this.blocked() ||
      this.conflict() ||
      !this.editable()
    )
      return;
    this.pending.set(true);
    this.error.set("");
    if (this.removal?.assetId !== slot.assetId)
      this.removal = { assetId: slot.assetId, version: row.version, key: crypto.randomUUID() };
    try {
      await this.client.mutate(
        "removeAsset",
        {
          expectedVersion: this.removal.version,
          assetId: slot.assetId,
        },
        row.resourceId,
        this.removal.key,
      );
      const latest = await this.client.getContent(row.resourceId);
      if (!this.destroyed) this.accept(latest);
      this.removal = undefined;
    } catch (error) {
      if (!this.destroyed) {
        this.conflict.set(error instanceof JawStackApiError && error.status === 409);
        this.error.set(
          this.conflict()
            ? "Content changed. Refresh before changing attachments."
            : "Removal could not be confirmed. Retry or refresh to check the attachment.",
        );
      }
    } finally {
      this.pending.set(false);
    }
  }
}
