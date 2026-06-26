import { describe, expect, it } from "vitest";

import { describePackage, packageName } from "../src/index";

describe("@jawstack/aws-cdk", () => {
  it("exports the package scaffold", () => {
    expect(packageName).toBe("@jawstack/aws-cdk");
    expect(describePackage()).toContain(packageName);
  });
});
