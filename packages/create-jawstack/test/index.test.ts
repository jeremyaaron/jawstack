import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  generateJawStackApp,
  describePackage,
  getHelpText,
  packageName,
  runCreateJawStackCli,
} from "../src/index";

const execFileAsync = promisify(execFile);
const tempDirectories: string[] = [];
const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("create-jawstack", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
  });

  it("exports the project generator metadata", () => {
    expect(packageName).toBe("create-jawstack");
    expect(describePackage()).toContain("project generator");
  });

  it("renders help", () => {
    expect(getHelpText()).toContain("create-jawstack <app-name>");
    expect(getHelpText()).toContain("--force");
  });

  it("generates an Angular resource workflow starter", async () => {
    const directory = await makeTempDirectory();
    const targetDirectory = join(directory, "my-product-app");
    const result = await generateJawStackApp({
      localPackageRoot: repositoryRoot,
      targetDirectory,
    });

    const packageJson = JSON.parse(
      await readFile(join(targetDirectory, "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      name: string;
      scripts: Record<string, string>;
    };
    const indexHtml = await readFile(join(targetDirectory, "index.html"), "utf8");

    expect(result.appPackageName).toBe("my-product-app");
    expect(result.nextSteps).toContain("pnpm dev:web");
    expect(packageJson.name).toBe("my-product-app");
    expect(packageJson.dependencies["@jawstack/core"]).toContain("packages/core");
    expect(packageJson.dependencies["@jawstack/angular"]).toContain("packages/angular");
    expect(packageJson.dependencies["@jawstack/aws-cdk"]).toContain("packages/aws-cdk");
    expect(packageJson.dependencies["@jawstack/aws-runtime"]).toContain("packages/aws-runtime");
    expect(packageJson.dependencies["@jawstack/cli"]).toContain("packages/cli");
    expect(packageJson.scripts).toMatchObject({
      "build:aws": "node scripts/build-aws-entrypoints.mjs",
      "deploy:dev": "jawstack deploy dev",
      "destroy:dev": "jawstack destroy dev",
      doctor: "jawstack doctor",
      "doctor:deploy": "jawstack doctor --deploy --stage dev",
      "dev:api": "tsx src/api.ts",
      "dev:web": "vite --host 127.0.0.1",
      "smoke:dev": "jawstack smoke dev",
      test: "vitest run --config vitest.config.ts",
      typecheck: "tsc --noEmit -p tsconfig.json",
    });
    expect(indexHtml).toContain("<title>My Product App</title>");
    await expect(readFile(join(targetDirectory, "jawstack.config.ts"), "utf8")).resolves.toContain(
      "defineJawStackApp",
    );
    await expect(readFile(join(targetDirectory, "cdk.json"), "utf8")).resolves.toContain(
      "pnpm build:aws",
    );
    await expect(
      readFile(join(targetDirectory, "scripts", "build-aws-entrypoints.mjs"), "utf8"),
    ).resolves.toContain("src/aws/api.ts");
    await expect(readFile(join(targetDirectory, ".gitignore"), "utf8")).resolves.toContain("dist/");
  });

  it("refuses to generate into a non-empty directory unless forced", async () => {
    const directory = await makeTempDirectory();
    const targetDirectory = join(directory, "existing-app");

    await mkdir(targetDirectory);
    await writeFile(join(targetDirectory, "README.md"), "existing");

    await expect(generateJawStackApp({ targetDirectory })).rejects.toThrow("not empty");
    await expect(generateJawStackApp({ force: true, targetDirectory })).resolves.toMatchObject({
      appPackageName: "existing-app",
    });
  });

  it("runs through the local CLI entrypoint", async () => {
    const directory = await makeTempDirectory();
    const stdout = new StringWritable();
    const stderr = new StringWritable();
    const exitCode = await runCreateJawStackCli(
      ["cli-app", "--local-package-root", repositoryRoot],
      {
        cwd: directory,
        stderr,
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("Created Cli App");
    await expect(readFile(join(directory, "cli-app", "src/example.ts"), "utf8")).resolves.toContain(
      "workRequestResource",
    );
  });

  it("generates a fixture that installs, typechecks, and tests", async () => {
    const directory = await makeTempDirectory();
    const targetDirectory = join(directory, "fixture-app");

    await execFileAsync(
      "pnpm",
      [
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
        "run",
        "build",
      ],
      {
        cwd: repositoryRoot,
        timeout: 120_000,
      },
    );
    await generateJawStackApp({
      localPackageRoot: repositoryRoot,
      targetDirectory,
    });

    await execFileAsync("pnpm", ["install", "--offline"], {
      cwd: targetDirectory,
      timeout: 120_000,
    });
    await execFileAsync("pnpm", ["typecheck"], {
      cwd: targetDirectory,
      timeout: 120_000,
    });
    await execFileAsync("pnpm", ["test"], {
      cwd: targetDirectory,
      timeout: 120_000,
    });
    await execFileAsync("pnpm", ["doctor"], {
      cwd: targetDirectory,
      timeout: 120_000,
    });
    await execFileAsync("pnpm", ["build:aws"], {
      cwd: targetDirectory,
      timeout: 120_000,
    });
    await execFileAsync("pnpm", ["synth"], {
      cwd: targetDirectory,
      timeout: 120_000,
    });
  }, 240_000);
});

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "create-jawstack-"));
  tempDirectories.push(directory);
  return directory;
}

class StringWritable extends Writable {
  value = "";

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += chunk.toString();
    callback();
  }
}
