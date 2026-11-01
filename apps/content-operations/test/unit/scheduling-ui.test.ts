import "@angular/compiler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryApiRuntime } from "../../src/application/api-runtime";
import { createFixtureClock } from "../../src/application/runtime";
import { startContentApi } from "../../src/http/server";
import { ContentOperationsClient } from "../../src/web/client";
import { ScheduleSession } from "../../src/web/schedule-session";
import type { FixtureId } from "../../src/shared/identities";
import { calendarMonth, calendarState, shiftCalendarMonth } from "../../src/shared/calendar";
import { localDateAt, utcToLocal, zonedLabel } from "../../src/shared/time";

const apis: Awaited<ReturnType<typeof startContentApi>>[] = [];
afterEach(async () => {
  await Promise.all(apis.splice(0).map((api) => api.close()));
  vi.restoreAllMocks();
});
async function setup() {
  const clock = createFixtureClock("2027-03-01T12:00:00.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => clock.now().getTime());
  const runtime = createMemoryApiRuntime({ clock: clock.now });
  const api = await startContentApi({ runtime, port: 0, managed: false });
  apis.push(api);
  let actor: FixtureId = "author_1";
  const client = new ContentOperationsClient({ fixture: () => actor, base: `${api.baseUrl}/api` });
  const created = await client.mutate("create", {
    title: "Scheduled proof",
    body: "Approved body",
  });
  const id = created.resourceId;
  await client.mutate(
    "submit",
    { expectedVersion: 1, assignedEditorId: "editor_1", dueAt: "2027-03-02T12:00:00.000Z" },
    id,
  );
  let row = await client.getContent(id);
  actor = "editor_1";
  await client.mutate(
    "approve",
    {
      expectedVersion: row.version,
      reviewId: row.state.review!.reviewId,
      revisionId: row.state.revisionId,
      note: "Approved",
    },
    id,
  );
  row = await client.getContent(id);
  let blocked = false;
  const session = new ScheduleSession(
    client,
    () => actor,
    () => row,
    (next) => {
      row = next;
    },
    () => blocked,
  );
  session.reset(row);
  return {
    session,
    client,
    runtime,
    clock,
    id,
    row: () => row,
    actor: (next: FixtureId) => {
      actor = next;
    },
    block: (value: boolean) => {
      blocked = value;
    },
  };
}
describe("calendar dates and explicit zones", () => {
  it("bounds local months across DST, unusual offsets, skipped dates, leap years and 42-cell grids", () => {
    for (const zone of [
      "UTC",
      "America/New_York",
      "Australia/Lord_Howe",
      "Asia/Kathmandu",
      "Pacific/Apia",
    ]) {
      for (let m = 1; m <= 12; m++) {
        const month = calendarMonth(`2026-${String(m).padStart(2, "0")}-15`, zone);
        expect(month.days).toHaveLength(42);
        const duration = Date.parse(month.query.before) - Date.parse(month.query.from);
        expect(duration).toBeGreaterThan(27 * 86400000);
        expect(duration).toBeLessThanOrEqual(32 * 86400000);
      }
    }
    expect(calendarMonth("2024-02-29", "UTC").days.filter((day) => day.inMonth)).toHaveLength(29);
    const fallback = calendarMonth("2026-11-15", "America/New_York").query;
    expect(fallback.from).toBe("2026-11-01T04:00:00.000Z");
    expect(fallback.before).toBe("2026-12-01T05:00:00.000Z");
    expect(shiftCalendarMonth("2026-01-31", 1)).toBe("2026-02-28");
    expect(shiftCalendarMonth("0001-01-01", -1)).toBeUndefined();
    expect(calendarMonth("2011-12-01", "Pacific/Apia").query.before).toBe(
      "2011-12-31T10:00:00.000Z",
    );
  });
  it("rejects invalid URL state rather than normalizing dates or guessing a zone", () => {
    for (const input of [
      { date: "2026-02-30" },
      { date: "2026-11" },
      { zone: "+02:00" },
      { zone: "Not/A_Zone" },
      { view: "year" },
      { limit: 101 },
    ])
      expect(() => calendarState(input)).toThrow();
    expect(
      calendarState({ zone: "America/New_York" }, new Date("2026-11-01T00:30:00.000Z")).date,
    ).toBe("2026-10-31");
  });
  it("preserves explicit instants and distinguishes repeated wall clocks by their displayed offsets", () => {
    expect(utcToLocal("2026-11-01T05:30:00.123Z", "America/New_York")).toBe(
      "2026-11-01T01:30:00.123",
    );
    expect(localDateAt("2026-11-01T00:30:00.000Z", "America/New_York")).toBe("2026-10-31");
    expect(zonedLabel("2026-11-01T05:30:00.000Z", "America/New_York")).not.toBe(
      zonedLabel("2026-11-01T06:30:00.000Z", "America/New_York"),
    );
  });
});
describe("HTTP-backed scheduling session", () => {
  it("rejects clock gaps, folds, invalid zones and past times without dispatching", async () => {
    const h = await setup();
    const mutate = vi.spyOn(h.client, "mutate");
    for (const value of [
      { at: "2027-03-14T02:30", zone: "America/New_York" },
      { at: "2027-11-07T01:30", zone: "America/New_York" },
      { at: "2027-02-30T12:00", zone: "UTC" },
      { at: "2027-03-02T12:00", zone: "+02:00" },
      { at: "2027-02-01T12:00", zone: "UTC" },
    ]) {
      h.session.form.setValue(value);
      await h.session.save();
      expect(h.session.validation()).not.toBe("");
      expect(h.session.form.getRawValue()).toEqual(value);
    }
    expect(mutate).not.toHaveBeenCalled();
    expect(h.row().version).toBe(3);
    h.session.destroy();
  });
  it("reuses schedule and reschedule keys after a lost command response or lost strong read", async () => {
    const h = await setup();
    h.session.form.setValue({ at: "2027-03-02T09:15:30.123", zone: "America/New_York" });
    const original = h.client.mutate.bind(h.client);
    let lost = true;
    const mutate = vi.spyOn(h.client, "mutate").mockImplementation(async (name, input, id, key) => {
      const result = await original(name, input, id, key);
      if (lost) {
        lost = false;
        throw new TypeError("Response lost");
      }
      return result;
    });
    await h.session.save();
    expect(h.session.dirty()).toBe(true);
    expect(h.row().version).toBe(3);
    await h.session.save();
    expect(mutate.mock.calls[0]![3]).toBe(mutate.mock.calls[1]![3]);
    expect(h.row().version).toBe(4);
    expect(h.row().state.schedule?.scheduledAt).toBe("2027-03-02T14:15:30.123Z");
    h.session.form.controls.at.setValue("2027-03-03T10:00");
    vi.spyOn(h.client, "getContent").mockRejectedValueOnce(new TypeError("Read lost"));
    await h.session.save();
    expect(h.session.error()).toContain("committed");
    expect(h.row().version).toBe(4);
    await h.session.save();
    expect(mutate.mock.calls[2]![3]).toBe(mutate.mock.calls[3]![3]);
    expect(h.row().version).toBe(5);
    expect(h.session.dirty()).toBe(false);
    h.session.destroy();
  });
  it("pins content version and generation on conflict and preserves the proposed wall clock", async () => {
    const h = await setup();
    await h.session.save();
    const stale = h.row();
    const schedule = stale.state.schedule!;
    await h.client.mutate(
      "reschedule",
      {
        expectedVersion: stale.version,
        reviewId: stale.state.approval!.reviewId,
        revisionId: stale.state.revisionId,
        scheduleGeneration: schedule.generation,
        scheduledAt: "2027-03-04T12:00:00.000Z",
        timeZone: "UTC",
      },
      h.id,
    );
    h.session.form.setValue({ at: "2027-03-05T10:00", zone: "Asia/Kathmandu" });
    await h.session.save();
    expect(h.session.action.conflict()).toBe(true);
    expect(h.row().version).toBe(stale.version);
    expect(h.row().state.schedule?.generation).toBe(schedule.generation);
    expect(h.session.form.controls.at.value).toBe("2027-03-05T10:00");
    const mutate = vi.spyOn(h.client, "mutate");
    await h.session.cancel();
    expect(mutate).not.toHaveBeenCalled();
    h.session.destroy();
  });
  it("uses real due jobs: reschedule, cancel and reopen invalidate old generations, then a current schedule publishes", async () => {
    const h = await setup();
    h.session.form.setValue({ at: "2027-03-01T13:00", zone: "UTC" });
    await h.session.save();
    const first = h.row().state.schedule!;
    h.session.form.controls.at.setValue("2027-03-01T14:00");
    await h.session.save();
    expect(h.row().state.schedule!.generation).not.toBe(first.generation);
    h.clock.advance(3600000);
    await h.runtime.tick!();
    await h.runtime.app.drainUntilIdle();
    expect((await h.client.getContent(h.id)).state.status).toBe("scheduled");
    await h.session.cancel();
    h.clock.advance(3600000);
    await h.runtime.tick!();
    await h.runtime.app.drainUntilIdle();
    expect((await h.client.getContent(h.id)).state.status).toBe("approved");
    h.session.form.controls.at.setValue("2027-03-01T15:00");
    await h.session.save();
    h.clock.advance(3600000);
    await h.runtime.tick!();
    await h.runtime.app.drainUntilIdle();
    const published = await h.client.getContent(h.id);
    expect(published.state.status).toBe("published");
    expect((await h.client.publication(h.id)).artifact.schedule?.generation).toBe(
      published.state.publication!.intent.schedule!.generation,
    );
    h.session.destroy();
  });
  it("excludes foreign/blocked actions and pages calendar rows within the requested UTC month", async () => {
    const h = await setup();
    h.actor("author_1");
    expect(h.session.editable()).toBe(false);
    await h.session.save();
    expect(h.row().version).toBe(3);
    h.actor("editor_2");
    h.block(true);
    await h.session.save();
    expect(h.row().version).toBe(3);
    h.block(false);
    await h.session.save();
    const range = calendarMonth("2027-03-01", "America/New_York").query;
    const page = await h.client.calendar({ ...range, limit: 1 });
    expect(page.items.map((row) => row.itemId)).toEqual([h.id]);
    expect(page.items[0]!.data.generation).toBe(h.row().state.schedule!.generation);
    await h.client.mutate("reopenDraft", { expectedVersion: h.row().version }, h.id);
    expect((await h.client.calendar(range)).items).toEqual([]);
    h.clock.advance(3 * 86400000);
    await h.runtime.tick!();
    await h.runtime.app.drainUntilIdle();
    expect((await h.client.getContent(h.id)).state.status).toBe("draft");
    h.session.destroy();
  });
});
