import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("presentation browser boundary", () => {
  it("bundles real components and presentation-only metadata without Node, core runtime, or AWS imports", () => {
    const result = execFileSync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/verify-browser.mjs", import.meta.url)), "--source"],
      { encoding: "utf8" },
    );
    expect(JSON.parse(result)).toMatchObject({
      status: "passed",
      mode: "source",
      serverImports: 0,
    });
  });
});
