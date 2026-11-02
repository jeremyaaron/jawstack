import { LabError } from "./config";
import { waitFor } from "./lifecycle";

export function assertOwned(tags: Record<string, string> | undefined, ownerId: string): void {
  if (tags?.["jawstack:owner"] !== ownerId)
    throw new LabError("Refusing to modify a resource not owned by this lab manifest.");
}
export function assertMapping(
  mapping: { UUID?: string | undefined; EventSourceArn?: string | undefined },
  expectedSource: string | undefined,
  context = "event source mapping",
): string {
  if (!mapping.UUID || !expectedSource || mapping.EventSourceArn !== expectedSource)
    throw new LabError(`Unexpected ${context}; refusing cleanup.`);
  return mapping.UUID;
}
export async function deleteMappings(
  ids: readonly string[],
  remove: (id: string) => Promise<unknown>,
  exists: (id: string) => Promise<boolean>,
) {
  if (
    ids.length > 200 ||
    ids.some((id) => !id || id.length > 128) ||
    new Set(ids).size !== ids.length
  )
    throw new LabError("Invalid bounded mapping inventory; refusing cleanup.");
  for (const id of ids) {
    await remove(id);
    await waitFor("event mapping deletion", async () => ((await exists(id)) ? undefined : true));
  }
}
