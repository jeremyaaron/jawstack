import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@jawstack/aws-cdk": fileURLToPath(
        new URL("../../packages/aws-cdk/src/index.ts", import.meta.url),
      ),
      "@jawstack/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@jawstack/aws-runtime": fileURLToPath(
        new URL("../../packages/aws-runtime/src/index.ts", import.meta.url),
      ),
    },
  },
  test: { include: ["test/unit/**/*.test.ts"] },
});
