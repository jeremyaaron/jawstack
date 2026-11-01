import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createApiRuntime } from "../src/application/api-runtime";
import { startContentApi } from "../src/http/server";
import { assertCleanAwsEnvironment, createLabConfig, selectRuntime } from "../src/lab/config";

export function apiSettings(args: string[], env: NodeJS.ProcessEnv = {}) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { port: { type: "string" }, "web-port": { type: "string" }, lab: { type: "string" } },
  });
  if (positionals.length !== 1) throw new Error("Select one explicit runtime.");
  const runtime = selectRuntime(positionals[0]);
  assertCleanAwsEnvironment(env);
  if (
    (env.CONTENT_OPS_API_HOST && env.CONTENT_OPS_API_HOST !== "127.0.0.1") ||
    (env.CONTENT_OPS_STAGE && !["local", "dev"].includes(env.CONTENT_OPS_STAGE))
  )
    throw new Error("Only loopback local development configuration is supported.");
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(values.port ?? env.CONTENT_OPS_API_PORT ?? 4327);
  const webPort = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(values["web-port"] ?? env.CONTENT_OPS_WEB_PORT ?? 4326);
  if (port === webPort) throw new Error("API and web ports must differ.");
  const labId = values.lab ?? env.CONTENT_OPS_LAB_ID ?? "dev";
  createLabConfig(labId);
  if (env.CONTENT_OPS_RUNTIME && env.CONTENT_OPS_RUNTIME !== runtime)
    throw new Error("Runtime selection conflicts with environment.");
  return { runtime, port, webPort, labId };
}
async function main() {
  const config = apiSettings(process.argv.slice(2), process.env);
  const runtime = await createApiRuntime(config);
  const api = await startContentApi({ runtime, port: config.port, webPort: config.webPort });
  console.log(`Content Operations ${runtime.kind} API: ${api.baseUrl}`);
  let stopping = false;
  const stop = () => {
    if (!stopping) {
      stopping = true;
      void api.close().catch(() => {
        process.exitCode = 1;
      });
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(
      typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE"
        ? "API port is occupied. Choose an explicit --port override."
        : "API startup failed. Check runtime, ports, clean environment, and owned lab readiness.",
    );
    process.exitCode = 1;
  });
