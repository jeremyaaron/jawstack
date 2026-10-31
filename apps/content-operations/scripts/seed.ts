import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { selectRuntime } from "../src/lab/config";

export async function seedRunningApi(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: { runtime: { type: "string" }, port: { type: "string" } },
  });
  if (positionals.length) throw new Error("Unexpected seed arguments.");
  const runtime = selectRuntime(values.runtime);
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(values.port ?? 4327);
  const base = `http://127.0.0.1:${port}`;
  const health: unknown = await (
    await fetch(`${base}/api/health`, { redirect: "error", signal: AbortSignal.timeout(5000) })
  ).json();
  const parsed = z
    .object({ ok: z.literal(true), data: z.object({ runtime: z.literal(runtime) }) })
    .parse(health);
  if (parsed.data.runtime !== runtime) throw new Error("Runtime mismatch.");
  const response = await fetch(`${base}/api/development/seed`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
    headers: { "content-type": "application/json", "x-content-ops-fixture": "editor_1" },
    body: JSON.stringify({ confirm: true }),
  });
  const body: unknown = await response.json();
  return z
    .object({
      ok: z.literal(true),
      data: z.object({ created: z.array(z.uuid()), skipped: z.array(z.uuid()) }),
    })
    .parse(body).data;
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  seedRunningApi(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch(() => {
      console.error(
        "Seed failed. Start the matching local API and select --runtime memory or localstack.",
      );
      process.exitCode = 1;
    });
