import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { LabError, parseProfile, type LabProfile } from "./config";

export const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export const profileHash = (input: unknown) => sha256(canonical(parseProfile(input)));
export async function archiveIdentity(path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.size > 50 * 1024 * 1024)
    throw new LabError("Expected a bounded prebuilt ZIP archive.");
  const bytes = await readFile(path);
  if (
    bytes.length < 4 ||
    bytes.length > 50 * 1024 * 1024 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    !path.endsWith(".zip")
  )
    throw new LabError("Expected a bounded prebuilt ZIP archive.");
  return { path, sha256: sha256(bytes) };
}
export async function verifyArchives(profile: LabProfile): Promise<void> {
  for (const fn of parseProfile(profile).functions) {
    let actual: Awaited<ReturnType<typeof archiveIdentity>>;
    try {
      actual = await archiveIdentity(fn.archive.path);
    } catch {
      throw new LabError("Cannot verify the declared lab archives; refusing mutation.");
    }
    if (actual.sha256 !== fn.archive.sha256)
      throw new LabError("Lab archive identity changed; explicit down/recreation required.");
  }
}
