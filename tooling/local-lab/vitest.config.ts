import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@jawstack/aws-runtime/local": fileURLToPath(
        new URL("../../packages/aws-runtime/src/local.ts", import.meta.url),
      ),
      "@jawstack/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: { include: ["test/**/*.test.ts"], maxWorkers: 2 },
});
