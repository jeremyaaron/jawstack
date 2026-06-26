import { describe, expect, it } from "vitest";

import { describePackage, packageName } from "../src/index";

describe("@jawstack/aws-runtime", () => {
  it("exports the package scaffold", () => {
    expect(packageName).toBe("@jawstack/aws-runtime");
    expect(describePackage()).toContain(packageName);
  });
});
