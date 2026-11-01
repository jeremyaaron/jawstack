import { signal } from "@angular/core";
import { JawStackApiError } from "@jawstack/angular";
import type { ContentOperationsClient, CommandName, CommandInput } from "./client";
import type { FixtureId } from "../shared/identities";

export class EditorialAction {
  readonly pending = signal(false);
  readonly error = signal("");
  readonly conflict = signal(false);
  private intent: { signature: string; key: string } | undefined;
  constructor(
    private readonly client: ContentOperationsClient,
    private readonly fixture: () => FixtureId,
    private readonly conflictMessage = "This review changed. Your input is preserved.",
  ) {}
  reset() {
    this.error.set("");
    this.conflict.set(false);
    this.intent = undefined;
  }
  async run<N extends CommandName>(name: N, input: CommandInput<N>, id: string) {
    if (this.pending() || this.conflict()) return;
    const signature = JSON.stringify([this.fixture(), id, name, input]);
    if (signature !== this.intent?.signature) this.intent = { signature, key: crypto.randomUUID() };
    this.pending.set(true);
    this.error.set("");
    try {
      return await this.client.mutate(name, input, id, this.intent.key);
    } catch (error) {
      this.conflict.set(error instanceof JawStackApiError && error.status === 409);
      this.error.set(
        this.conflict()
          ? this.conflictMessage
          : error instanceof JawStackApiError && error.status === 403
            ? "This identity cannot perform this action."
            : "The action could not complete. Your input is preserved.",
      );
      return undefined;
    } finally {
      this.pending.set(false);
    }
  }
}
