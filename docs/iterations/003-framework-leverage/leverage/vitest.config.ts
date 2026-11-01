import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../../../..");
const task = process.env.JAWSTACK_LEVERAGE_TASK;
if (!["a", "b", "compat"].includes(task ?? "")) throw new Error("Use the exercise runner.");
if (task !== "compat" && !process.env.JAWSTACK_LEVERAGE_ADAPTER)
  throw new Error("No candidate adapter configured.");
export default defineConfig({
  root,
  resolve: {
    alias: {
      "@jawstack/core": resolve(root, "packages/core/src/index.ts"),
      "@jawstack/aws-runtime": resolve(root, "packages/aws-runtime/src/index.ts"),
      "@jawstack/aws-cdk": resolve(root, "packages/aws-cdk/src/index.ts"),
      "leverage:candidate": process.env.JAWSTACK_LEVERAGE_ADAPTER ?? "unused-in-compatibility",
    },
  },
  test: {
    include: [
      resolve(
        directory,
        task === "compat" ? "compatibility.acceptance.ts" : `task-${task}.acceptance.ts`,
      ),
    ],
    maxWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
