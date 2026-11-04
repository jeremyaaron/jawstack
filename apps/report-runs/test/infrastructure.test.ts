import { describe, expect, it } from "vitest";
import { Template } from "aws-cdk-lib/assertions";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { unzipSync } from "fflate";
import { buildReport } from "../scripts/build";
import { reportProfile } from "../scripts/profile";
import { createReportStack } from "../scripts/synth";
import { localBindings, topology } from "../src/local-config";
import { reportDefinition, createMemoryReport } from "../src/workflow";
import { seed, seedIds } from "../scripts/seed";
const ownerId = "20000000-0000-4000-8000-000000000001";
describe("independent public composition", () => {
  it("builds import-pure real entrypoints and registers only the minimal finite lab", async () => {
    const archives = await buildReport(),
      profile = await reportProfile("test", archives);
    expect(profile.resources.buckets).toEqual([]);
    expect(profile.resources.scheduleGroups).toEqual([]);
    expect(profile.services?.schedules).toEqual([]);
    expect(profile.functions.map((f) => f.handler).sort()).toEqual([
      "index.dispatcher",
      "index.handler",
      "index.handler",
    ]);
    expect(profile.resources.tables).toHaveLength(1);
    expect(profile.resources.buses).toHaveLength(1);
    expect(profile.resources.queues).toHaveLength(2);
    expect(profile.services?.workflowHash).toBe(
      reportDefinition(topology("test").source).manifest.hash,
    );
    const binding = localBindings({ labId: "test", ownerId, profileHash: "a".repeat(64) });
    expect(binding.consumers[0]!.consumer).toBe("buildInventory");
    const dir = await mkdtemp(join(tmpdir(), "report-bundles-"));
    try {
      for (const name of ["outbox", "worker", "collector", "api"]) {
        const zip = unzipSync(await readFile(archives[name]!));
        const folder = join(dir, name);
        const { mkdir } = await import("node:fs/promises");
        await mkdir(folder);
        for (const [file, data] of Object.entries(zip)) await writeFile(join(folder, file), data);
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            "const m=await import(" +
              JSON.stringify(pathToFileURL(join(folder, "index.mjs")).href) +
              ");" +
              (name === "outbox"
                ? 'if(typeof m.dispatcher!=="function"||typeof m.sweeper!=="function")throw Error();'
                : 'if(typeof m.handler!=="function")throw Error();') +
              'process.stdout.write("pure");',
          ],
          {
            env: {
              PATH: process.env.PATH,
              AWS_PROFILE: "must-not-load",
              LOCALSTACK_AUTH_TOKEN: "must-not-read",
            },
            timeout: 10000,
          },
        );
        expect(stdout).toBe("pure");
        expect(Buffer.from(zip["runtime.mjs"]!).toString()).not.toMatch(
          /CONTENT_OPS_|VERIFY#|LOCALSTACK_AUTH_TOKEN/,
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const { app, stack, workflow } = createReportStack(
      archives,
      "test",
      join(tmpdir(), "report-synth-" + crypto.randomUUID()),
    );
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.resourceCountIs("AWS::S3::Bucket", 0);
    template.resourceCountIs("AWS::Scheduler::Schedule", 0);
    template.resourceCountIs("AWS::SQS::Queue", 2);
    expect(Object.keys(workflow.collectorFunctionsByName)).toEqual(["buildInventory"]);
    const resources = template.toJSON().Resources as Record<
      string,
      { Type: string; Properties: Record<string, unknown> }
    >;
    const queue = Object.values(resources).filter((r) => r.Type === "AWS::SQS::Queue");
    expect(queue.every((r) => r.Properties.VisibilityTimeout === 180)).toBe(true);
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "jawstack-report-runs-test-local-buildinventory-worker",
      Timeout: 30,
      MemorySize: 256,
      ReservedConcurrentExecutions: 2,
    });
    expect(app.outdir).toContain("report-synth-");
  }, 30000);
  it("seeds both adapters through ordinary non-overwriting commands", async () => {
    const workflow = createMemoryReport();
    try {
      await seed(workflow);
      await workflow.drainUntilIdle();
      const before = await Promise.all(
        seedIds.map((id) => workflow.repository.getState("reportRun", id)),
      );
      await seed(workflow);
      await workflow.drainUntilIdle();
      expect(
        await Promise.all(seedIds.map((id) => workflow.repository.getState("reportRun", id))),
      ).toEqual(before);
      expect(before.every((row) => row?.version === 2)).toBe(true);
    } finally {
      await workflow.close();
    }
  });
  it("refuses unsafe local identities and partial/foreign configuration without runtime startup", () => {
    expect(() => topology("../other")).toThrow();
    expect(() =>
      localBindings({ labId: "test", ownerId: "bad", profileHash: "a".repeat(64) }),
    ).toThrow();
    const b = localBindings({ labId: "test", ownerId, profileHash: "a".repeat(64) });
    expect(b.functions).toHaveLength(3);
    expect(b).not.toHaveProperty("services");
  });
});
