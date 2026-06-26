import { describe, expect, it } from "vitest";

import { describePackage, getHelpText, packageName } from "../src/index";

describe("@jawstack/cli", () => {
  it("exports the package scaffold", () => {
    expect(packageName).toBe("@jawstack/cli");
    expect(describePackage()).toContain(packageName);
  });

  it("renders placeholder help", () => {
    expect(getHelpText()).toContain("jawstack");
  });
});
