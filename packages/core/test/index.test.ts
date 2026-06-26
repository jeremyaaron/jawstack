import { describe, expect, it } from "vitest";

import { describePackage, packageName } from "../src/index";

describe("@jawstack/core", () => {
  it("exports the package scaffold", () => {
    expect(packageName).toBe("@jawstack/core");
    expect(describePackage()).toContain(packageName);
  });
});
