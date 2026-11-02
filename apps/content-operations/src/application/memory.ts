import { createMemoryWorkflowPersistence, InMemoryRepository, InMemoryStore } from "@jawstack/core";
import { createContentStorageSpec } from "./workflow";

const owners = new WeakMap<InMemoryStore, ReturnType<typeof createMemoryWorkflowPersistence>>();
export const contentMemoryPersistence = (store: InMemoryStore) => owners.get(store);
export function createMemoryPersistence(options: { source?: string; store?: InMemoryStore } = {}) {
  const shared = createMemoryWorkflowPersistence({
    ...(options.store ? { store: options.store } : {}),
    planner: createContentStorageSpec(options.source).planner,
  });
  owners.set(shared.store, shared);
  return { ...shared, repository: new InMemoryRepository(shared.store) };
}
