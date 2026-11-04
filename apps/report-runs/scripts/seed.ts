import { parseArgs } from "node:util";
import { createMemoryReport, fixtureAuth } from "../src/workflow";
import { openLocal } from "./open-local";
import { fileURLToPath } from "node:url";
export const seedIds = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
];
export async function seed(
  workflow: Pick<ReturnType<typeof createMemoryReport>, "repository" | "dispatch">,
) {
  for (const [index, id] of seedIds.entries()) {
    if (await workflow.repository.getState("reportRun", id!)) continue;
    const result = await workflow.dispatch(
      {
        resourceType: "reportRun",
        resourceId: id!,
        commandName: "request",
        input: {
          items: [
            { itemId: "fixture", label: "Inventory fixture " + (index + 1), quantity: index },
          ],
        },
        idempotencyKey: "seed:" + id,
        requestContext: {},
      },
      fixtureAuth("requester_" + (index + 1)),
    );
    if (!result.ok && result.error.code !== "resource.conflict")
      throw new Error("Seed request failed.");
  }
}
async function main() {
  const { values } = parseArgs({
    options: {
      runtime: { type: "string" },
      lab: { type: "string" },
      confirm: { type: "boolean" },
    },
    strict: true,
  });
  if (!values.confirm || values.runtime !== "localstack")
    throw new Error("Seeding requires --runtime localstack --confirm.");
  const workflow = await openLocal(values.lab ?? "dev");
  try {
    await seed(workflow);
    console.log(JSON.stringify({ status: "seeded", ids: seedIds }));
  } finally {
    await workflow.close();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  void main().catch(() => {
    console.error("Seed failed; no existing report is overwritten.");
    process.exitCode = 1;
  });
