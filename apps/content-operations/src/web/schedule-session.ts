import { signal } from "@angular/core";
import { FormControl, FormGroup } from "@angular/forms";
import { scheduleInput } from "../shared/publication-inputs";
import { localTimeToUtc, utcToLocal } from "../shared/time";
import type { FixtureId } from "../shared/identities";
import type { ContentOperationsClient, ContentResource, CommandInput } from "./client";
import { EditorialAction } from "./editorial-action";

export class ScheduleSession {
  readonly form = new FormGroup({
    at: new FormControl("", { nonNullable: true }),
    zone: new FormControl("UTC", { nonNullable: true }),
  });
  readonly dirty = signal(false);
  readonly pending = signal(false);
  readonly validation = signal("");
  readonly message = signal("");
  readonly error = signal("");
  readonly action: EditorialAction;
  private baseline = "";
  private destroyed = false;
  private readonly subscription = this.form.valueChanges.subscribe(() => {
    this.dirty.set(JSON.stringify(this.form.getRawValue()) !== this.baseline);
    this.validation.set("");
    this.message.set("");
  });
  constructor(
    private readonly client: ContentOperationsClient,
    private readonly fixture: () => FixtureId,
    readonly row: () => ContentResource | undefined,
    private readonly accept: (row: ContentResource) => void,
    private readonly blocked: () => boolean,
  ) {
    this.action = new EditorialAction(
      client,
      fixture,
      "The schedule or content changed. Your local time and zone are preserved. Refresh before another schedule action.",
    );
  }
  editable() {
    const row = this.row();
    return (
      !!row &&
      this.fixture().startsWith("editor") &&
      ["approved", "scheduled"].includes(row.state.status) &&
      !!row.state.approval
    );
  }
  reset(row?: ContentResource) {
    const schedule = row?.state.schedule;
    const value = {
      at: schedule
        ? utcToLocal(schedule.scheduledAt, schedule.timeZone)
        : utcToLocal(new Date(Date.now() + 86400000).toISOString(), "UTC"),
      zone: schedule?.timeZone ?? "UTC",
    };
    this.form.setValue(value, { emitEvent: false });
    this.baseline = JSON.stringify(value);
    this.dirty.set(false);
    this.validation.set("");
    this.error.set("");
    this.message.set("");
    this.action.reset();
  }
  instant() {
    try {
      const value = this.form.getRawValue();
      return localTimeToUtc(value.at, value.zone);
    } catch {
      return "";
    }
  }
  async save() {
    const row = this.row();
    if (!row || !this.editable() || this.pending() || this.blocked() || this.action.conflict())
      return;
    let input: CommandInput<"schedule">;
    try {
      const value = this.form.getRawValue();
      input = scheduleInput.parse({
        expectedVersion: row.version,
        reviewId: row.state.approval!.reviewId,
        revisionId: row.state.revisionId,
        scheduledAt: localTimeToUtc(value.at, value.zone),
        timeZone: value.zone,
      });
    } catch {
      this.validation.set(
        "Choose a valid, unambiguous local date/time and IANA time zone. Clock gaps and repeated times are not accepted.",
      );
      return;
    }
    if (Date.parse(input.scheduledAt) <= Date.now()) {
      this.validation.set("Select a future publication time.");
      return;
    }
    if (row.state.status === "scheduled") {
      if (!row.state.schedule) return;
      await this.execute("reschedule", {
        ...input,
        scheduleGeneration: row.state.schedule.generation,
      });
    } else await this.execute("schedule", input);
  }
  async cancel() {
    const row = this.row();
    if (!row?.state.schedule || !this.editable()) return;
    await this.execute("cancelSchedule", {
      expectedVersion: row.version,
      revisionId: row.state.revisionId,
      scheduleGeneration: row.state.schedule.generation,
    });
  }
  private async execute<N extends "schedule" | "reschedule" | "cancelSchedule">(
    name: N,
    input: CommandInput<N>,
  ) {
    const row = this.row();
    if (!row || this.pending() || this.blocked() || this.action.conflict()) return;
    this.pending.set(true);
    this.error.set("");
    this.validation.set("");
    this.message.set("");
    try {
      const result = await this.action.run(name, input, row.resourceId);
      if (!result || this.destroyed) return;
      this.baseline = JSON.stringify(this.form.getRawValue());
      this.dirty.set(false);
      try {
        const latest = await this.client.getContent(row.resourceId);
        if (this.destroyed) return;
        this.accept(latest);
        this.reset(latest);
        this.message.set(name === "cancelSchedule" ? "Schedule cancelled." : "Schedule saved.");
      } catch {
        if (!this.destroyed)
          this.error.set(
            "The command committed, but latest content could not be loaded. Retry the same action or refresh to check its outcome.",
          );
      }
    } finally {
      this.pending.set(false);
    }
  }
  destroy() {
    this.destroyed = true;
    this.subscription.unsubscribe();
  }
}
