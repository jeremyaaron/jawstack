import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@jawstack/angular": new URL("./packages/angular/src/index.ts", import.meta.url).pathname,
      "@jawstack/aws-cdk": new URL("./packages/aws-cdk/src/index.ts", import.meta.url).pathname,
      "@jawstack/aws-runtime": new URL("./packages/aws-runtime/src/index.ts", import.meta.url)
        .pathname,
      "@jawstack/cli": new URL("./packages/cli/src/index.ts", import.meta.url).pathname,
      "@jawstack/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["**/*.test.ts"],
  },
});
