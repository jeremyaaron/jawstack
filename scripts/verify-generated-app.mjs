#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(join(tmpdir(), "jawstack-generated-"));
const appDirectory = join(tempRoot, "generated-work-requests");

try {
  run("pnpm", [
    "--filter",
    "@jawstack/core",
    "--filter",
    "@jawstack/angular",
    "--filter",
    "@jawstack/aws-cdk",
    "--filter",
    "@jawstack/aws-runtime",
    "--filter",
    "@jawstack/cli",
    "--filter",
    "create-jawstack",
    "run",
    "build",
  ]);
  run("node", [
    join(repositoryRoot, "packages/create-jawstack/dist/cli.js"),
    appDirectory,
    "--local-package-root",
    repositoryRoot,
  ]);

  validateGeneratedPackage(appDirectory);

  run("pnpm", ["install", "--offline", "--loglevel", "error"], appDirectory);
  run("pnpm", ["typecheck"], appDirectory);
  run("pnpm", ["test"], appDirectory);
  run("pnpm", ["build"], appDirectory);
  run("pnpm", ["build:aws"], appDirectory);
  run("pnpm", ["synth"], appDirectory);
  run("pnpm", ["exec", "jawstack", "doctor"], appDirectory);

  process.stdout.write(`Generated app verification passed at ${appDirectory}\n`);
} finally {
  if (process.env.JAWSTACK_KEEP_GENERATED_APP !== "1") {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function run(command, args, cwd = repositoryRoot) {
  process.stdout.write(`\n$ ${command} ${args.join(" ")}\n`);
  execFileSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
}

function validateGeneratedPackage(directory) {
  const packageJson = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const config = readFileSync(join(directory, "jawstack.config.ts"), "utf8");

  assertEqual(packageJson.name, "generated-work-requests", "generated package name");
  assertScript(packageJson, "build");
  assertScript(packageJson, "build:aws");
  assertScript(packageJson, "deploy:dev");
  assertScript(packageJson, "destroy:dev");
  assertScript(packageJson, "doctor");
  assertScript(packageJson, "doctor:deploy");
  assertScript(packageJson, "synth");
  assertScript(packageJson, "smoke:dev");
  assertScript(packageJson, "test");
  assertScript(packageJson, "typecheck");
  assertScript(packageJson, "dev:api");
  assertScript(packageJson, "dev:web");
  assertLocalDependency(packageJson, "@jawstack/angular", "packages/angular");
  assertLocalDependency(packageJson, "@jawstack/aws-cdk", "packages/aws-cdk");
  assertLocalDependency(packageJson, "@jawstack/aws-runtime", "packages/aws-runtime");
  assertLocalDependency(packageJson, "@jawstack/cli", "packages/cli");
  assertLocalDependency(packageJson, "@jawstack/core", "packages/core");

  if (!config.includes("defineJawStackApp") || !config.includes("demoResources")) {
    throw new Error("Generated jawstack.config.ts does not reference the starter metadata.");
  }
}

function assertScript(packageJson, scriptName) {
  if (typeof packageJson.scripts?.[scriptName] !== "string") {
    throw new Error(`Generated package is missing script "${scriptName}".`);
  }
}

function assertLocalDependency(packageJson, dependencyName, expectedPathPart) {
  const version =
    packageJson.dependencies?.[dependencyName] ?? packageJson.devDependencies?.[dependencyName];

  if (typeof version !== "string" || !version.includes(expectedPathPart)) {
    throw new Error(
      `Generated package dependency ${dependencyName} should reference ${expectedPathPart}.`,
    );
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Unexpected ${label}: expected ${expected}, received ${String(actual)}.`);
  }
}
