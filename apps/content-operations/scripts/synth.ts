import { App, Stack } from "aws-cdk-lib";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ContentOperationsInfrastructure } from "../src/infra/stack";
import { contentInfrastructureConfig } from "../src/infra/config";
import { buildInfrastructure } from "./build-infra";

export async function synthContentInfrastructure(args: string[] = []) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: { lab: { type: "string" }, stage: { type: "string" }, runtime: { type: "string" } },
  });
  const config = contentInfrastructureConfig({
    ...(values.lab !== undefined ? { labId: values.lab } : {}),
    ...(values.stage !== undefined ? { stage: values.stage } : {}),
    ...(values.runtime !== undefined ? { runtime: values.runtime } : {}),
  });
  const entrypoints = await buildInfrastructure();
  const outdir = fileURLToPath(new URL("../cdk.out/", import.meta.url));
  const app = new App({ outdir, autoSynth: false });
  const stack = new Stack(app, "ContentOperationsLocal", {
    env: { account: "000000000000", region: config.lab.region },
    description: "Synthesis only: local emulator, dev fixtures, no real AWS execution.",
  });
  new ContentOperationsInfrastructure(stack, "ContentOperations", {
    entrypoints,
    labId: config.lab.instanceId,
  });
  app.synth();
  return { outdir, stackName: stack.stackName, mode: "synthesis-only", auth: config.auth };
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  synthContentInfrastructure(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch(() => {
      console.error(
        "Local-only synthesis failed. Build workspace packages and check arguments/assets; no deploy was attempted.",
      );
      process.exitCode = 1;
    });
