import { parseArgs } from "node:util";
import { createMemoryReport } from "../src/workflow";
import { startReportApi } from "../src/server";
import { openLocal } from "./open-local";
import { seed } from "./seed";
async function main() {
  const mode = process.argv[2];
  if (mode !== "memory" && mode !== "localstack") throw new Error("Choose memory or localstack.");
  const { values } = parseArgs({
    args: process.argv.slice(3),
    strict: true,
    options: {
      port: { type: "string" },
      lab: { type: "string" },
      seed: { type: "boolean" },
      "confirm-seed": { type: "boolean" },
    },
  });
  if (!!values.seed !== !!values["confirm-seed"])
    throw new Error("Seeding requires --seed --confirm-seed.");
  if (mode === "memory" && values.lab) throw new Error("--lab requires localstack.");
  const port = Number(values.port ?? "4347");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
  const app =
    mode === "memory"
      ? { kind: "memory" as const, workflow: createMemoryReport() }
      : { kind: "localstack" as const, workflow: await openLocal(values.lab ?? "dev") };
  if (values.seed) {
    try {
      await seed(app.workflow);
    } catch (error) {
      await app.workflow.close();
      throw error;
    }
  }
  const api = await startReportApi(app, { port });
  console.log("Report Runs " + mode + " API: " + api.url);
  const stop = () => {
    void api.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
void main().catch(() => {
  console.error("Report API startup failed; check mode, port and owned lab.");
  process.exitCode = 1;
});
