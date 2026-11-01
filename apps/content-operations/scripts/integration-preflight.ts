import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export function integrationEligibility(env: NodeJS.ProcessEnv) {
  if (!env.LOCALSTACK_AUTH_TOKEN?.trim())
    return { status: "not-run", reason: "LocalStack token is missing." } as const;
  if (env.CONTENT_OPS_LOCALSTACK_PLAN !== "hobby")
    return { status: "not-run", reason: "Hobby entitlement has not been attested." } as const;
  return { status: "ready", reason: "Token supplied; Hobby entitlement user-attested." } as const;
}
async function main() {
  const result = integrationEligibility(process.env);
  const message = `${result.status.toUpperCase()}: ${result.reason}`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  if (result.status !== "ready") process.exitCode = 1;
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  void main().catch(() => {
    console.error("NOT-RUN: Integration preflight could not complete.");
    process.exitCode = 1;
  });
