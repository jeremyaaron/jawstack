#!/usr/bin/env node
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(projectRoot, "dist", "aws");

const entrypoints = [
  ["api", "src/aws/api.ts"],
  ["outbox", "src/aws/outbox.ts"],
  ["send-notification-worker", "src/aws/send-notification-worker.ts"],
  ["stale-work-request-reminder", "src/aws/stale-work-request-reminder.ts"],
];

await rm(outDir, { recursive: true, force: true });

await Promise.all(
  entrypoints.map(([name, entrypoint]) =>
    build({
      entryPoints: [join(projectRoot, entrypoint)],
      outfile: join(outDir, name, "index.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      sourcemap: true,
      logLevel: "warning",
    }),
  ),
);
