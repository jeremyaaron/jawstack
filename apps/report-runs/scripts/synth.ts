import { App, Stack } from "aws-cdk-lib";
import { JawStackResourceWorkflowApp } from "@jawstack/aws-cdk";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { reportDefinition } from "../src/workflow";
import { reportResource } from "../src/domain";
import { topology } from "../src/local-config";
import { buildReport, root } from "./build";
export function createReportStack(
  archives: Record<string, string>,
  labId = "dev",
  outdir = root + "cdk.out",
) {
  const t = topology(labId),
    definition = reportDefinition(t.source);
  if (labId.length > 11) throw new Error("The CDK layout supports lab IDs up to 11 characters.");
  const app = new App({ autoSynth: false, outdir });
  const stack = new Stack(app, "ReportRunsLocal", {
    env: { account: "000000000000", region: "us-east-1" },
    description: "Synthesis only; local fixtures, no real AWS deployment.",
  });
  const workflow = new JawStackResourceWorkflowApp(stack, "Workflow", {
    appName: t.project,
    stage: "local",
    resources: [reportResource],
    auth: { mode: "dev", provider: "fixtures" },
    removalPolicy: "destroy",
    costProfile: {
      lambda: {
        defaultTimeoutSeconds: 30,
        maxTimeoutSeconds: 30,
        defaultMemoryMb: 256,
        reservedConcurrency: 2,
      },
      queues: { defaultMaxConcurrency: 2, maxReceiveCount: 3 },
      dynamodb: { pointInTimeRecovery: false },
    },
    recoverableWorkers: { definition, collectorHandler: archives.collector! },
    entrypoints: {
      apiHandler: archives.api!,
      outboxHandler: archives.outbox!,
      workerHandlers: { buildInventory: archives.worker! },
    },
  });
  const collector = workflow.collectorFunctionsByName.buildInventory;
  const worker = workflow.workerBindingsByName.buildInventory;
  if (!collector || !worker) throw new Error("Missing report worker bindings.");
  for (const fn of [
    workflow.apiFunction,
    workflow.outboxDispatcherFunction,
    workflow.outboxSweeperFunction,
    collector,
    worker.workerFunction,
  ]) {
    fn.addEnvironment("REPORT_RUNS_LAB_ID", labId);
    fn.addEnvironment("REPORT_RUNS_LAYOUT", "cdk");
  }
  return { app, stack, workflow };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ strict: true, options: { lab: { type: "string" } } });
  const { app } = createReportStack(await buildReport(), values.lab ?? "dev");
  app.synth();
  console.log(JSON.stringify({ mode: "synthesis-only", outdir: app.outdir }));
}
