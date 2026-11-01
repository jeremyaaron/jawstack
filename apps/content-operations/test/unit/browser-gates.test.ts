import { describe, expect, it } from "vitest";
import { readFile, readdir, mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { browserConfig, browserSettings } from "../../scripts/browser-config";
import { integrationEligibility } from "../../scripts/integration-preflight";
import { inspectDiagnostics } from "../../scripts/browser-diagnostics";
import unitConfig from "../../vitest.config";

type Step = {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  if?: string;
};
type Workflow = {
  on: Record<string, unknown>;
  permissions: { contents: string };
  jobs: Record<
    string,
    { if?: string; environment?: string; "timeout-minutes": number; steps: Step[] }
  >;
};
const workflows = new URL("../../../../.github/workflows/", import.meta.url);
const workflow = async (name: string) =>
  parse(await readFile(new URL(name, workflows), "utf8")) as Workflow;

describe("browser and integration gate boundaries", () => {
  it("resolves all declared JawStack source paths without prebuilt package output", async () => {
    const configUrl = new URL("../../tsconfig.json", import.meta.url);
    const config = JSON.parse(await readFile(configUrl, "utf8")) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    for (const [name, paths] of Object.entries(config.compilerOptions.paths)) {
      expect(paths).toHaveLength(1);
      const source = fileURLToPath(new URL(paths[0]!, configUrl));
      expect(source).toMatch(/[/\\]packages[/\\][^/\\]+[/\\]src[/\\]index\.ts$/);
      expect(unitConfig.resolve?.alias).toMatchObject({ [name]: source });
    }
  });
  it("separates owned memory/local ports and rejects unsafe settings", () => {
    expect(unitConfig.test?.include).toEqual(["test/unit/**/*.test.ts"]);
    expect(browserSettings("memory")).toMatchObject({ apiPort: 4437, webPort: 4436 });
    expect(browserSettings("localstack")).toMatchObject({ apiPort: 4537, webPort: 4536 });
    for (const env of [
      { CONTENT_OPS_E2E_API_PORT: "0" },
      { CONTENT_OPS_E2E_WEB_PORT: "65536" },
      { CONTENT_OPS_E2E_API_PORT: "4436" },
      { CONTENT_OPS_LAB_ID: "../other" },
    ])
      expect(() => browserSettings("memory", env)).toThrow();
    for (const runtime of ["memory", "localstack"] as const) {
      const config = browserConfig(runtime, {});
      expect(config.workers).toBe(1);
      expect(config.retries).toBe(0);
      expect(config.globalTimeout).toBe(600_000);
      expect(config.projects).toHaveLength(2);
      for (const server of config.webServer as {
        reuseExistingServer: boolean;
        gracefulShutdown: { signal: string };
      }[]) {
        expect(server.reuseExistingServer).toBe(false);
        expect(server.gracefulShutdown.signal).toBe("SIGTERM");
      }
      expect(config.testMatch).toBe(runtime === "localstack" ? "workflow.spec.ts" : undefined);
    }
  });
  it("reports unavailable credentials as NOT-RUN without echoing values", () => {
    expect(integrationEligibility({}).status).toBe("not-run");
    expect(integrationEligibility({ LOCALSTACK_AUTH_TOKEN: " " }).status).toBe("not-run");
    expect(
      integrationEligibility({
        LOCALSTACK_AUTH_TOKEN: "private",
        CONTENT_OPS_LOCALSTACK_PLAN: "trial",
      }).status,
    ).toBe("not-run");
    const result = integrationEligibility({
      LOCALSTACK_AUTH_TOKEN: "private",
      CONTENT_OPS_LOCALSTACK_PLAN: "hobby",
    });
    expect(result.status).toBe("ready");
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("exits unsuccessfully for missing credentials without loading a dotenv file", async () => {
    await expect(
      promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("../../scripts/integration-preflight.ts", import.meta.url)),
        ],
        {
          env: { PATH: process.env.PATH },
          timeout: 10_000,
          maxBuffer: 8192,
        },
      ),
    ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("NOT-RUN") });
  });
  it("bounds diagnostic files/bytes and refuses symlinks instead of following them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "content-browser-diagnostics-"));
    try {
      const file = join(directory, "result.json");
      await writeFile(file, "12345");
      expect(await inspectDiagnostics([directory])).toEqual({ files: 1, bytes: 5 });
      await expect(inspectDiagnostics([directory], { files: 1, bytes: 4 })).rejects.toThrow(
        "budget",
      );
      await writeFile(join(directory, "second.json"), "x");
      await expect(inspectDiagnostics([directory], { files: 1, bytes: 10 })).rejects.toThrow(
        "budget",
      );
      await symlink(file, join(directory, "link.json"));
      await expect(inspectDiagnostics([directory])).rejects.toThrow("symlinks");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("keeps every CI trigger PR/manual only, read-only, finite and credential-unpersisted", async () => {
    for (const name of await readdir(workflows)) {
      const config = await workflow(name);
      expect(
        Object.keys(config.on).every((event) =>
          ["pull_request", "workflow_dispatch"].includes(event),
        ),
      ).toBe(true);
      expect(config.permissions.contents).toBe("read");
      for (const job of Object.values(config.jobs)) {
        expect(job["timeout-minutes"]).toBeGreaterThan(0);
        expect(job["timeout-minutes"]).toBeLessThanOrEqual(50);
        expect(
          job.steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.[
            "persist-credentials"
          ],
        ).toBe(false);
        for (const step of job.steps.filter((step) =>
          step.uses?.startsWith("actions/upload-artifact@"),
        )) {
          expect(step.with?.["retention-days"]).toBe(7);
          expect(step.if).toContain("steps.diagnostics.outputs.within-budget == 'true'");
          expect(step.with?.["include-hidden-files"]).toBeUndefined();
          expect(String(step.with?.path)).not.toContain(".localstack");
        }
      }
    }
  });
  it("keeps PR browser jobs secret-free and LocalStack behind default-branch manual/environment gates", async () => {
    const pr = await workflow("ci.yml");
    expect(pr.jobs.browser!.steps.some((step) => step.run?.includes("run test:browser"))).toBe(
      true,
    );
    expect(JSON.stringify(pr)).not.toMatch(/secrets\.|LOCALSTACK_AUTH_TOKEN|pull_request_target/);
    const local = await workflow("content-operations-local.yml");
    expect(Object.keys(local.on)).toEqual(["workflow_dispatch"]);
    const job = local.jobs.localstack!;
    expect(job.environment).toBe("localstack-hobby");
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(job.if).toContain("github.event.repository.default_branch");
    const secretSteps = job.steps.filter((step) => step.env?.LOCALSTACK_AUTH_TOKEN);
    expect(secretSteps.map((step) => step.run)).toEqual([
      "pnpm --filter content-operations run integration:preflight",
      "pnpm --filter content-operations run local:up",
    ]);
    const cleanup = job.steps.find((step) => step.run?.includes("run local:down"));
    expect(cleanup?.if).toBe("always()");
  });
});
