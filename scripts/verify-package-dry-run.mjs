#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectories = [
  "packages/core",
  "packages/aws-runtime",
  "packages/aws-cdk",
  "packages/angular",
  "packages/cli",
  "packages/create-jawstack",
];

for (const packageDirectory of packageDirectories) {
  verifyPackage(packageDirectory);
}

process.stdout.write(`Verified ${packageDirectories.length} package dry runs.\n`);

function verifyPackage(packageDirectory) {
  const cwd = join(repositoryRoot, packageDirectory);
  const packageJson = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [packResult] = JSON.parse(output);

  if (packResult === undefined) {
    throw new Error(`npm pack did not return metadata for ${packageDirectory}.`);
  }

  const files = packResult.files.map((file) => file.path).sort();
  const requiredFiles = [
    "LICENSE",
    "README.md",
    "package.json",
    "dist/index.d.ts",
    "dist/index.js",
  ];

  if (packageJson.bin !== undefined) {
    for (const binPath of Object.values(packageJson.bin)) {
      requiredFiles.push(binPath.replace(/^\.\//u, ""));
    }
  }

  if (packageJson.name === "create-jawstack") {
    requiredFiles.push(
      "dist/templates/angular-resource-workflow/package.json",
      "dist/templates/angular-resource-workflow/jawstack.config.ts",
      "dist/templates/angular-resource-workflow/src/example.ts",
    );
  }

  for (const requiredFile of requiredFiles) {
    if (!files.includes(requiredFile)) {
      throw new Error(`${packageJson.name} dry-run package is missing ${requiredFile}.`);
    }
  }

  const forbidden = files.filter(
    (file) =>
      file.startsWith("src/") ||
      file.startsWith("test/") ||
      file.endsWith(".tsbuildinfo") ||
      file === "tsconfig.json",
  );

  if (forbidden.length > 0) {
    throw new Error(
      `${packageJson.name} dry-run package includes non-publish files: ${forbidden.join(", ")}.`,
    );
  }

  if (String(packResult.version) !== String(packageJson.version)) {
    throw new Error(
      `${packageJson.name} dry-run version mismatch: expected ${packageJson.version}, received ${packResult.version}.`,
    );
  }

  process.stdout.write(
    `${packageJson.name}@${packageJson.version}: ${files.length} files, ${packResult.unpackedSize} bytes unpacked\n`,
  );
}
