import { describe, expect, it } from "vitest";
import { forbidden } from "../../vite.config";

describe("consumer browser boundary", () => {
  it("rejects both package and resolved server imports, including the legacy shim", () => {
    for (const id of [
      "/repo/node_modules/.pnpm/@aws-sdk+client-s3@3.0.0/node_modules/@aws-sdk/client-s3/index.js",
      "/repo/node_modules/.pnpm/@smithy+core@1.0.0/node_modules/@smithy/core/index.js",
      "/repo/packages/aws-runtime/src/index.ts",
      "/repo/node_modules/aws-cdk-lib/index.js",
      "/repo/node_modules/constructs/index.js",
    ])
      expect(forbidden(id), id).toBe(true);
    for (const id of [
      "node:http",
      "fs/promises",
      "@jawstack/core",
      "@jawstack/aws-runtime",
      "@jawstack/aws-cdk",
      "@aws-sdk/client-s3",
      "@smithy/node-http-handler",
      "aws-cdk-lib",
      "constructs",
      "/repo/packages/core/src/index.ts",
      "/repo/apps/content-operations/src/domain/resources.ts",
      "/repo/apps/content-operations/src/application/runtime.ts",
      "/repo/apps/content-operations/src/aws/persistence.ts",
      "/repo/apps/content-operations/src/http/server.ts",
      "/repo/apps/content-operations/src/lab/config.ts",
      "/repo/apps/demo-work-requests/src/browser-shims/node-http.ts",
    ])
      expect(forbidden(id), id).toBe(true);
    for (const id of [
      "@jawstack/angular",
      "@angular/core",
      "zod",
      "/repo/apps/content-operations/src/shared/presentation.ts",
      "/repo/apps/content-operations/src/web/client.ts",
    ])
      expect(forbidden(id), id).toBe(false);
  });
});
