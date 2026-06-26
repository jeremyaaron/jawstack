import { describe, expect, it } from "vitest";

import { describePackage, packageName } from "../src/index";

describe("@jawstack/angular", () => {
  it("exports the package scaffold", () => {
    expect(packageName).toBe("@jawstack/angular");
    expect(describePackage()).toContain(packageName);
  });
});
