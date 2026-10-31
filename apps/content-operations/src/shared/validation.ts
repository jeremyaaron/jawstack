import { z } from "zod";

export const limits = Object.freeze({
  title: 160,
  bodyBytes: 32 * 1024,
  note: 2000,
  snapshotBytes: 64 * 1024,
  stateBytes: 160 * 1024,
  eventBytes: 80 * 1024,
  assetBytes: 10 * 1024 * 1024,
  activeAssets: 10,
  retainedAssets: 32,
  filename: 255,
  uploadLifetimeMs: 60 * 60 * 1000,
  publicationLeaseMs: 90_000,
  publicationAttempts: 3,
  publicationGenerations: 4,
  publicationArtifactBytes: 80 * 1024,
  orphanAgeMs: 24 * 60 * 60 * 1000,
});
export const jsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const idSchema = z.uuid();
export const versionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const instantSchema = z.iso.datetime({ precision: 3 });
export const offsetInstantSchema = z.iso
  .datetime({ offset: true, precision: 3 })
  .transform((value) => new Date(value).toISOString());
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    if (value !== "UTC" && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value)) return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Use a valid IANA time zone.");
export const validUnicode = (value: string) =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value;
