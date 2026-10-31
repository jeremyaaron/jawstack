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
});
export const jsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const idSchema = z.uuid();
export const versionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const instantSchema = z.iso.datetime({ precision: 3 });
export const validUnicode = (value: string) =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value;
