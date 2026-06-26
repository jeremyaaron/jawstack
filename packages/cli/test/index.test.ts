import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
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
      costProfile: ${options.costProfileSource ?? validCostProfileSource()}
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

  it("runs placeholder lifecycle commands", async () => {
    for (const command of ["deploy", "smoke", "destroy"]) {
      const result = await runCli([command]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("not implemented");
    }
  });
});
