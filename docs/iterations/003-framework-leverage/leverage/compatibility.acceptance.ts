import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { captureCompatibility } from "./compatibility-input";

describe("pre-extraction Content Operations storage/wire contract", () => {
  it("matches frozen keys, rows, byte order, fingerprints, recovery DTOs and marker keys", () => {
    const path = fileURLToPath(new URL("./compatibility.json", import.meta.url));
    const actual = captureCompatibility();
    if (process.env.JAWSTACK_CAPTURE_COMPAT === "1")
      writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`, { flag: "wx" });
    expect(actual).toEqual(JSON.parse(readFileSync(path, "utf8")));
    expect(actual.fingerprint).toBe(actual.wireJsonSha256);
  });
});
