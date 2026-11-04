import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      ["core", "aws-runtime/local", "aws-runtime", "aws-cdk"].map((name) => [
        "@jawstack/" + name,
        fileURLToPath(
          new URL(
            name === "aws-runtime/local"
              ? "../../packages/aws-runtime/src/local.ts"
              : "../../packages/" + name + "/src/index.ts",
            import.meta.url,
          ),
        ),
      ]),
    ),
  },
  test: { include: ["test/**/*.test.ts"], maxWorkers: 1 },
});
