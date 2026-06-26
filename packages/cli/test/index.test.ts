import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type CommandRunner,
  defineJawStackApp,
  describePackage,
  getHelpText,
  loadJawStackConfig,
  packageName,
  renderFindingsHuman,
  renderFindingsJson,
  runCli,
} from "../src/index";

const coreSourcePath = path.resolve(import.meta.dirname, "../../core/src/index.ts");

async function createFixture(configSource?: string): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "jawstack-cli-"));

  if (configSource !== undefined) {
    await writeFile(path.join(cwd, "jawstack.config.ts"), configSource);
  }

  return cwd;
}

function validCostProfileSource(overrides = ""): string {
  return `{
    lambda: {
      defaultTimeoutSeconds: 10,
      maxTimeoutSeconds: 60,
      defaultMemoryMb: 256,
      reservedConcurrency: 5
    },
    queues: {
      defaultMaxConcurrency: 2,
      maxReceiveCount: 3,
      requireDlq: true
    },
    dynamodb: {
      billingMode: "onDemand",
      maxReadRequestUnits: 100,
      maxWriteRequestUnits: 50
    },
    eventBridge: {
      preventSelfTriggeringLoops: true,
      requireEventSchemaVersion: true
    },
    scheduler: {
      maxRetryAttempts: 2,
      maxEventAgeSeconds: 300,
      requireDlq: true
    },
    ${overrides}
  }`;
}

function validConfigSource(
  options: {
    duplicate?: boolean;
    authSource?: string;
    awsSource?: string;
    costProfileSource?: string;
    stage?: string;
  } = {},
): string {
  const resources = options.duplicate
    ? "[workRequestResource, workRequestResource]"
    : "[workRequestResource]";
  const authSource =
    options.authSource ??
    `{
      mode: "test",
      provider: "test"
    }`;

  return `
    import { workRequestResource } from ${JSON.stringify(coreSourcePath)};

    export default {
      appName: "work-requests",
      stage: ${JSON.stringify(options.stage ?? "test")},
      resources: ${resources},
      auth: ${authSource},
      costProfile: ${options.costProfileSource ?? validCostProfileSource()},
      aws: ${options.awsSource ?? "{ region: 'us-east-1', profile: 'test-profile' }"}
    };
  `;
}

describe("@jawstack/cli", () => {
  it("exports the package CLI helpers", () => {
    const config = defineJawStackApp({
      appName: "example",
      resources: [],
      auth: {
        mode: "test",
        provider: "test",
      },
      costProfile: {},
    });

    expect(packageName).toBe("@jawstack/cli");
    expect(describePackage()).toContain(packageName);
    expect(config.appName).toBe("example");
  });

  it("renders command help", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("doctor");
    expect(result.stdout).toContain("manifest");
    expect(getHelpText()).toContain("destroy");
  });

  it("loads a TypeScript config from the default lookup path", async () => {
    const cwd = await createFixture(validConfigSource());
    const loaded = await loadJawStackConfig({ cwd });

    expect(path.basename(loaded.path)).toBe("jawstack.config.ts");
    expect(loaded.config.appName).toBe("work-requests");
    expect(loaded.config.resources[0]?.name).toBe("workRequest");
  });

  it("loads an ESM config from the default lookup path", async () => {
    const cwd = await createFixture();
    await writeFile(
      path.join(cwd, "jawstack.config.mjs"),
      `
        export default {
          appName: "esm-config",
          resources: [],
          auth: {
            mode: "test",
            provider: "test"
          },
          costProfile: {}
        };
      `,
    );

    const loaded = await loadJawStackConfig({ cwd });

    expect(path.basename(loaded.path)).toBe("jawstack.config.mjs");
    expect(loaded.config.appName).toBe("esm-config");
  });

  it("prints a deterministic stable manifest", async () => {
    const cwd = await createFixture(validConfigSource());
    const result = await runCli(["manifest", "--stable"], { cwd });
    const manifest = JSON.parse(result.stdout) as { generatedAt?: string; resources: unknown[] };

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(manifest.generatedAt).toBeUndefined();
    expect(manifest.resources).toHaveLength(1);
    expect(result.stdout).not.toContain("decide");
    expect(result.stdout).not.toContain("safeParse");
  });

  it("returns clean doctor output for a valid config", async () => {
    const cwd = await createFixture(validConfigSource());
    const result = await runCli(["doctor"], { cwd });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No findings.");
  });

  it("returns JSON findings for invalid registry config", async () => {
    const cwd = await createFixture(validConfigSource({ duplicate: true }));
    const result = await runCli(["doctor", "--json"], { cwd });
    const output = JSON.parse(result.stdout) as { findings: Array<{ id: string }> };

    expect(result.exitCode).toBe(1);
    expect(output.findings.map((finding) => finding.id)).toEqual(["resource.name.duplicate"]);
  });

  it("reports missing auth provider and cost guardrails", async () => {
    const cwd = await createFixture(
      validConfigSource({
        authSource: "{ mode: 'test' }",
        costProfileSource: "{}",
      }),
    );
    const result = await runCli(["doctor", "--json"], { cwd });
    const output = JSON.parse(result.stdout) as {
      findings: Array<{ id: string; severity: string; impact?: string; fix?: string }>;
    };

    expect(result.exitCode).toBe(1);
    expect(output.findings.map((finding) => finding.id)).toEqual([
      "auth.provider.missing",
      "cost.lambda.timeout.missing",
      "cost.lambda.memory.missing",
      "cost.lambda.concurrency.missing",
      "cost.queue.dlq.missing",
      "cost.queue.max-concurrency.missing",
      "cost.queue.max-receive-count.missing",
      "cost.dynamodb.billing-mode.invalid",
      "cost.dynamodb.throughput-guardrail.missing",
      "cost.scheduler.retry.missing",
      "cost.scheduler.dlq.missing",
      "event.loop.suspicious",
      "event.schema-version.missing",
    ]);
    expect(output.findings.every((finding) => finding.impact !== undefined)).toBe(true);
    expect(output.findings.every((finding) => finding.fix !== undefined)).toBe(true);
  });

  it("treats warnings as blocking in strict mode", async () => {
    const cwd = await createFixture(
      validConfigSource({
        costProfileSource: validCostProfileSource(`
          eventBridge: {
            preventSelfTriggeringLoops: false,
            requireEventSchemaVersion: true
          },
        `),
      }),
    );

    const relaxed = await runCli(["doctor"], { cwd });
    const strict = await runCli(["doctor", "--strict"], { cwd });

    expect(relaxed.exitCode).toBe(0);
    expect(relaxed.stdout).toContain("event.loop.suspicious");
    expect(strict.exitCode).toBe(1);
    expect(strict.stdout).toContain("event.loop.suspicious");
  });

  it("blocks deploy checks that use dev auth outside local stages", async () => {
    const cwd = await createFixture(
      validConfigSource({
        stage: "prod",
        authSource: "{ mode: 'dev', provider: 'dev' }",
      }),
    );
    const result = await runCli(["doctor", "--deploy", "--json"], { cwd });
    const output = JSON.parse(result.stdout) as { findings: Array<{ id: string }> };

    expect(result.exitCode).toBe(1);
    expect(output.findings.map((finding) => finding.id)).toEqual(["auth.dev.deploy-blocked"]);
  });

  it("reports deploy AWS readiness findings", async () => {
    const cwd = await createFixture(validConfigSource({ awsSource: "{}" }));
    const result = await runCli(["doctor", "--deploy", "--json"], {
      cwd,
      env: {},
    });
    const output = JSON.parse(result.stdout) as { findings: Array<{ id: string }> };

    expect(result.exitCode).toBe(1);
    expect(output.findings.map((finding) => finding.id)).toEqual([
      "aws.region.missing",
      "aws.credentials.unavailable",
    ]);
  });

  it("invokes CDK deploy with stage, region, profile, and outputs", async () => {
    const cwd = await createFixture(validConfigSource());
    const calls: Array<{
      command: string;
      args: readonly string[];
      env: Readonly<Record<string, string | undefined>>;
    }> = [];
    const commandRunner: CommandRunner = async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      const outputFile = args[args.indexOf("--outputs-file") + 1];

      if (outputFile !== undefined) {
        await writeFile(
          outputFile,
          JSON.stringify({
            WorkRequestsStack: {
              ApiUrl: "https://api.example.test",
              FrontendUrl: "https://app.example.test",
            },
          }),
        );
      }

      return {
        exitCode: 0,
        stdout: "cdk deploy output\n",
        stderr: "",
      };
    };

    const result = await runCli(["deploy", "prod", "--region", "us-west-2"], {
      commandRunner,
      cwd,
      env: {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("cdk deploy output");
    expect(result.stdout).toContain("Deployed work-requests prod.");
    expect(result.stdout).toContain("WorkRequestsStack.ApiUrl: https://api.example.test");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "pnpm",
      env: {
        AWS_DEFAULT_REGION: "us-west-2",
        AWS_PROFILE: "test-profile",
        AWS_REGION: "us-west-2",
      },
    });
    expect(calls[0]?.args).toEqual([
      "exec",
      "cdk",
      "deploy",
      "--context",
      "jawstackStage=prod",
      "--context",
      `jawstackConfig=${path.join(cwd, "jawstack.config.ts")}`,
      "--profile",
      "test-profile",
      "--require-approval",
      "never",
      "--outputs-file",
      path.join(cwd, ".jawstack", "outputs", "prod.json"),
    ]);
  });

  it("blocks deploy with dev auth unless explicitly overridden", async () => {
    const cwd = await createFixture(
      validConfigSource({
        authSource: "{ mode: 'dev', provider: 'dev' }",
      }),
    );
    let calls = 0;
    const commandRunner: CommandRunner = async () => {
      calls += 1;
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    };

    const blocked = await runCli(["deploy", "prod"], {
      commandRunner,
      cwd,
      env: {},
    });
    const allowed = await runCli(["deploy", "prod", "--allow-dev-auth"], {
      commandRunner,
      cwd,
      env: {},
    });

    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain("auth.dev.deploy-blocked");
    expect(allowed.exitCode).toBe(0);
    expect(calls).toBe(1);
  });

  it("invokes CDK destroy with stage, region, and force", async () => {
    const cwd = await createFixture(validConfigSource({ stage: "dev" }));
    const calls: Array<{
      command: string;
      args: readonly string[];
      env: Readonly<Record<string, string | undefined>>;
    }> = [];
    const commandRunner: CommandRunner = async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return {
        exitCode: 0,
        stdout: "cdk destroy output\n",
        stderr: "",
      };
    };

    const result = await runCli(["destroy", "--profile", "override-profile"], {
      commandRunner,
      cwd,
      env: {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cdk destroy output");
    expect(result.stdout).toContain("Destroyed work-requests dev.");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.env).toMatchObject({
      AWS_DEFAULT_REGION: "us-east-1",
      AWS_PROFILE: "override-profile",
      AWS_REGION: "us-east-1",
    });
    expect(calls[0]?.args).toEqual([
      "exec",
      "cdk",
      "destroy",
      "--context",
      "jawstackStage=dev",
      "--context",
      `jawstackConfig=${path.join(cwd, "jawstack.config.ts")}`,
      "--profile",
      "override-profile",
      "--force",
    ]);
  });

  it("returns exit code 2 when config is missing", async () => {
    const cwd = await createFixture();
    const result = await runCli(["manifest"], { cwd });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("config.missing");
  });

  it("returns exit code 2 when config shape is invalid", async () => {
    const cwd = await createFixture("export default { appName: '' };");
    const result = await runCli(["doctor"], { cwd });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("config.invalid");
  });

  it("renders human and JSON reporters", () => {
    const findings = [
      {
        id: "example.error",
        severity: "error" as const,
        title: "Example",
        message: "Example message.",
        location: {
          path: "resources[0]",
          resource: "workRequest",
        },
        impact: "Things fail.",
        fix: "Fix things.",
      },
    ];

    expect(renderFindingsHuman(findings)).toContain("ERROR example.error");
    expect(JSON.parse(renderFindingsJson(findings))).toEqual({ findings });
  });

  it("keeps smoke as the remaining placeholder lifecycle command", async () => {
    const result = await runCli(["smoke"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("not implemented");
  });
});
