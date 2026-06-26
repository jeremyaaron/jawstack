import { describe, expect, it } from "vitest";

import { describePackage, getHelpText, packageName } from "../src/index";

describe("create-jawstack", () => {
  it("exports the package scaffold", () => {
    expect(packageName).toBe("create-jawstack");
    expect(describePackage()).toContain(packageName);
  });

  it("renders placeholder help", () => {
    expect(getHelpText()).toContain("create-jawstack");
  });
});
