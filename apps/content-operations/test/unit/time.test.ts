import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { localTimeToUtc } from "../../src/shared/time";
import { submitInput } from "../../src/shared/contracts";
import { scheduleInput } from "../../src/shared/publication-inputs";
import { offsetInstantSchema } from "../../src/shared/validation";

describe("explicit temporal inputs", () => {
  it.each([
    ["2026-03-08T02:30", "America/New_York"],
    ["2026-11-01T01:30", "America/New_York"],
    ["2026-10-04T02:15", "Australia/Lord_Howe"],
    ["2026-04-05T01:45", "Australia/Lord_Howe"],
    ["2026-02-30T12:00", "UTC"],
    ["2026-10-31T25:00", "UTC"],
    ["2026-10-31T12:00Z", "UTC"],
    ["2026-10-31T12:00+02:00", "Europe/Paris"],
    ["2026-10-31T12:00", "+02:00"],
  ])("rejects ambiguous, nonexistent or invalid local %s in %s", (local, zone) => {
    expect(() => localTimeToUtc(local, zone)).toThrow();
  });
  it("converts valid local times without global Temporal patching and preserves millisecond precision", () => {
    expect(localTimeToUtc("2026-10-31T12:34", "America/New_York")).toBe("2026-10-31T16:34:00.000Z");
    expect(localTimeToUtc("2026-10-31T12:34:56.789", "Asia/Kathmandu")).toBe(
      "2026-10-31T06:49:56.789Z",
    );
    expect(localTimeToUtc("2026-10-31T12:34:56.789", "UTC")).toBe("2026-10-31T12:34:56.789Z");
  });
  it("normalizes explicit offsets for review/schedule inputs but never guesses local offsets", () => {
    const dueAt = "2026-11-01T01:30:00.000-04:00";
    expect(
      submitInput.parse({ expectedVersion: 1, assignedEditorId: "editor_1", dueAt }).dueAt,
    ).toBe("2026-11-01T05:30:00.000Z");
    expect(offsetInstantSchema.parse("2026-11-01T01:30:00.000-05:00")).toBe(
      "2026-11-01T06:30:00.000Z",
    );
    const id = "00000000-0000-4000-8000-000000000001";
    expect(
      scheduleInput.parse({
        expectedVersion: 1,
        reviewId: id,
        revisionId: id,
        scheduledAt: dueAt,
        timeZone: "America/New_York",
      }).scheduledAt,
    ).toBe("2026-11-01T05:30:00.000Z");
    for (const value of [
      "2026-11-01T01:30:00.000",
      "2026-02-30T01:30:00.000Z",
      "2026-11-01",
      "2026-11-01T01:30:00.1234Z",
    ])
      expect(offsetInstantSchema.safeParse(value).success).toBe(false);
  });
  it("bundles the local conversion helper for browsers without Node or AWS imports", async () => {
    const result = await build({
      entryPoints: ["src/shared/time.ts"],
      bundle: true,
      write: false,
      platform: "browser",
      metafile: true,
    });
    expect(
      Object.keys(result.metafile!.inputs).some(
        (p) => p.includes("@aws-sdk") || p.includes("src/domain/"),
      ),
    ).toBe(false);
  });
});
