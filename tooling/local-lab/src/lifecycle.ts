import { LabError } from "./config";

export async function waitFor<T>(
  description: string,
  poll: () => Promise<T | undefined>,
  timeoutMs = 120_000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await poll();
    if (result !== undefined) return result;
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new LabError(`Timed out waiting for ${description}.`);
}
export async function missing<T>(request: () => Promise<T>): Promise<T | undefined> {
  try {
    return await request();
  } catch (error) {
    if (
      error instanceof Error &&
      [
        "ResourceNotFoundException",
        "ResourceNotFound",
        "NoSuchEntityException",
        "NoSuchEntity",
        "QueueDoesNotExist",
        "AWS.SimpleQueueService.NonExistentQueue",
        "NoSuchBucket",
        "NotFound",
      ].includes(error.name)
    )
      return undefined;
    throw error;
  }
}
