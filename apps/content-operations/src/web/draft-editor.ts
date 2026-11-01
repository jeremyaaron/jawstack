import { signal } from "@angular/core";
import { FormControl, FormGroup } from "@angular/forms";
import { JawStackApiError } from "@jawstack/angular";
import { createContentInput } from "../shared/contracts";
import type { FixtureId } from "../shared/identities";
import type { ContentOperationsClient, ContentResource } from "./client";

export function errorMessage(error: unknown) {
  if (error instanceof JawStackApiError) {
    if (error.status === 403)
      return "This identity cannot change this content. Your draft is preserved.";
    if (error.status === 409) return "Content changed on the server. Your draft is preserved.";
    if (error.status === 404) return "Content was not found.";
    return error.message;
  }
  return "The request could not complete. Your draft is preserved.";
}

export class DraftEditor {
  readonly form = new FormGroup({
    title: new FormControl("", { nonNullable: true }),
    body: new FormControl("", { nonNullable: true }),
  });
  readonly resource = signal<ContentResource | undefined>(undefined);
  readonly latest = signal<ContentResource | undefined>(undefined);
  readonly dirty = signal(false);
  readonly pending = signal(false);
  readonly error = signal("");
  readonly validation = signal("");
  readonly validationField = signal<"title" | "body" | undefined>(undefined);
  readonly conflict = signal(false);
  readonly saved = signal("");
  private baseline = JSON.stringify({ title: "", body: "" });
  private intent: { signature: string; key: string } | undefined;
  private readonly subscription = this.form.valueChanges.subscribe(() => {
    this.dirty.set(JSON.stringify(this.form.getRawValue()) !== this.baseline);
    this.saved.set("");
  });
  constructor(
    readonly client: ContentOperationsClient,
    readonly fixture: () => FixtureId,
  ) {}
  destroy() {
    this.subscription.unsubscribe();
  }
  editable() {
    const row = this.resource();
    return (
      !row ||
      (row.state.status === "draft" &&
        (this.fixture().startsWith("editor") || row.state.authorId === this.fixture()))
    );
  }
  accept(row?: ContentResource) {
    this.resource.set(row);
    this.latest.set(undefined);
    this.error.set("");
    this.validation.set("");
    this.validationField.set(undefined);
    this.conflict.set(false);
    this.intent = undefined;
    const draft = { title: row?.state.title ?? "", body: row?.state.body ?? "" };
    this.baseline = JSON.stringify(draft);
    this.form.setValue(draft, { emitEvent: false });
    this.dirty.set(false);
  }
  async save(): Promise<string | undefined> {
    if (this.pending() || this.conflict() || !this.editable()) return;
    const parsed = createContentInput.safeParse(this.form.getRawValue());
    if (!parsed.success) {
      this.validationField.set(parsed.error.issues[0]?.path[0] === "title" ? "title" : "body");
      this.validation.set(
        parsed.error.issues[0]?.path[0] === "title"
          ? "A title of 1-160 characters is required."
          : "Body must be valid text, at most 32 KiB UTF-8.",
      );
      return;
    }
    this.validation.set("");
    this.validationField.set(undefined);
    this.error.set("");
    this.saved.set("");
    this.pending.set(true);
    const row = this.resource();
    const input = row ? { ...parsed.data, expectedVersion: row.version } : parsed.data;
    const signature = JSON.stringify([this.fixture(), row?.resourceId, input]);
    if (this.intent?.signature !== signature) this.intent = { signature, key: crypto.randomUUID() };
    try {
      const result = row
        ? await this.client.mutate(
            "editDraft",
            { ...parsed.data, expectedVersion: row.version },
            row.resourceId,
            this.intent.key,
          )
        : await this.client.mutate("create", parsed.data, undefined, this.intent.key);
      // The command committed even if its following strong read is interrupted.
      const baseline = { ...parsed.data };
      this.baseline = JSON.stringify(baseline);
      this.form.setValue(baseline, { emitEvent: false });
      this.dirty.set(false);
      if (row)
        this.resource.set({
          ...row,
          version: result.version,
          state: { ...row.state, ...parsed.data },
        });
      this.intent = undefined;
      try {
        this.accept(await this.client.getContent(result.resourceId));
        this.saved.set("Saved");
      } catch {
        this.saved.set("Saved. Latest content could not be loaded.");
      }
      return result.resourceId;
    } catch (error) {
      this.error.set(errorMessage(error));
      this.conflict.set(error instanceof JawStackApiError && error.status === 409);
      return undefined;
    } finally {
      this.pending.set(false);
    }
  }
  async compare() {
    const row = this.resource();
    if (!row || this.pending()) return;
    this.pending.set(true);
    try {
      this.latest.set(await this.client.getContent(row.resourceId));
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.pending.set(false);
    }
  }
  keepLocal() {
    const latest = this.latest();
    if (!latest) return;
    this.resource.set(latest);
    this.latest.set(undefined);
    this.conflict.set(false);
    this.error.set("");
    this.intent = undefined;
    this.baseline = JSON.stringify({ title: latest.state.title, body: latest.state.body });
    this.dirty.set(JSON.stringify(this.form.getRawValue()) !== this.baseline);
  }
  useServer() {
    const latest = this.latest();
    if (latest) this.accept(latest);
  }
}
