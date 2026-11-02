import { createMemoryWorkflowPersistence, InMemoryRepository } from "@jawstack/core";
import { createContentStorageSpec } from "./workflow";

export function createMemoryPersistence(options: { source?: string } = {}) {
  const shared = createMemoryWorkflowPersistence({
    planner: createContentStorageSpec(options.source).planner,
  });
  return { ...shared, repository: new InMemoryRepository(shared.store) };
}
