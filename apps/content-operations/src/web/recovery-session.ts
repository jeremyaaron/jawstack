import { signal } from "@angular/core";
import type { ContentOperationsClient, ContentResource } from "./client";
import type { FixtureId } from "../shared/identities";
import { publicationRecovery } from "../shared/publication-recovery";
import { EditorialAction } from "./editorial-action";
import { VisibilityPoll } from "./visibility-poll";

export class RecoverySession {
  readonly pending = signal(false);
  readonly awaiting = signal(false);
  readonly now = signal(Date.now());
  readonly error = signal("");
  readonly action: EditorialAction;
  private readonly poll: VisibilityPoll;
  private request: AbortController | undefined;
  private destroyed = false;
  private signature = "";
  constructor(
    private readonly client: ContentOperationsClient,
    private readonly fixture: () => FixtureId,
    readonly row: () => ContentResource,
    private readonly accept: (row: ContentResource) => void,
    document: Document,
    private readonly blocked: () => boolean,
  ) {
    this.poll = new VisibilityPoll(document);
    this.action = new EditorialAction(
      client,
      fixture,
      "Publication changed. Refresh before another retry; the loaded version and generation are preserved.",
    );
  }
  policy() {
    const publication = this.row().state.publication;
    return publication ? publicationRecovery(publication, this.now()) : undefined;
  }
  canRetry() {
    return (
      this.fixture().startsWith("editor") &&
      this.row().state.status === "publishing" &&
      !!this.policy()?.eligible
    );
  }
  update() {
    const row = this.row();
    const signature = JSON.stringify([this.fixture(), row.resourceId, row.version]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.poll.stop();
    this.now.set(Date.now());
    this.action.reset();
    this.error.set("");
    this.awaiting.set(false);
    if (this.follows(row)) this.watch();
  }
  private follows(row: ContentResource) {
    const p = row.state.publication;
    return (
      !!p &&
      ["queued", "running"].includes(p.phase) &&
      !publicationRecovery(p, Date.now()).expiredLease
    );
  }
  private watch() {
    const id = this.row().resourceId;
    this.poll.start(async (signal) => {
      try {
        const latest = await this.client.getContent(id, signal);
        if (signal.aborted || this.destroyed || this.action.conflict()) return false;
        this.now.set(Date.now());
        this.error.set("");
        this.awaiting.set(false);
        if (latest.version !== this.row().version) this.accept(latest);
        return this.follows(latest);
      } catch {
        if (!signal.aborted)
          this.error.set("Publication status could not be loaded. Retrying while visible.");
        return true;
      }
    });
  }
  async retry() {
    this.now.set(Date.now());
    if (
      this.destroyed ||
      this.blocked() ||
      this.pending() ||
      this.awaiting() ||
      this.action.conflict() ||
      !this.canRetry()
    )
      return;
    const row = this.row();
    const p = row.state.publication!;
    this.pending.set(true);
    this.poll.stop();
    this.error.set("");
    try {
      const result = await this.action.run(
        "retryPublication",
        {
          expectedVersion: row.version,
          publicationId: p.intent.publicationId,
          generation: p.generation,
        },
        row.resourceId,
      );
      if (!result || this.destroyed) return;
      this.awaiting.set(true);
      this.request = new AbortController();
      try {
        const latest = await this.client.getContent(row.resourceId, this.request.signal);
        if (this.destroyed) return;
        this.awaiting.set(false);
        this.accept(latest);
      } catch {
        if (!this.destroyed) {
          this.error.set("Retry committed. Latest publication status could not be loaded.");
          this.watch();
        }
      }
    } finally {
      this.pending.set(false);
    }
  }
  async refresh() {
    if (this.destroyed || this.blocked() || this.pending()) return;
    this.pending.set(true);
    this.poll.stop();
    this.error.set("");
    this.request = new AbortController();
    try {
      const row = await this.client.getContent(this.row().resourceId, this.request.signal);
      if (this.destroyed) return;
      this.now.set(Date.now());
      this.action.reset();
      this.awaiting.set(false);
      this.accept(row);
      if (this.follows(row)) this.watch();
    } catch {
      if (!this.destroyed)
        this.error.set("Publication could not be refreshed. The loaded version is preserved.");
    } finally {
      this.pending.set(false);
    }
  }
  destroy() {
    this.destroyed = true;
    this.request?.abort();
    this.poll.destroy();
  }
}
