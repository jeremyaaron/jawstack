import {
  InMemoryStore,
  InMemoryRepository,
  InMemoryUnitOfWork,
  JawStackRuntimeError,
  type IdempotencyRecord,
} from "@jawstack/core";
import { projectionKey } from "@jawstack/aws-runtime";
import {
  captureScope,
  operationKey,
  prepareTransaction,
  type OperationRecord,
  type PersistenceFactory,
} from "./persistence";

export function createMemoryPersistence() {
  const store = new InMemoryStore();
  const repository = new InMemoryRepository(store);
  const operations = new Map<string, OperationRecord>();
  const idempotency = new Map<string, IdempotencyRecord & { expiresAt: number }>();
  let tail = Promise.resolve();
  const factory: PersistenceFactory = (context, instant) => {
    const scope = captureScope(context);
    const now = new Date(instant);
    const key = (value: string) =>
      JSON.stringify([scope.resourceType, scope.commandName, scope.subject, value]);
    const read = async (value: string) => {
      const record = idempotency.get(key(value));
      return record && record.expiresAt > Math.floor(now.getTime() / 1000)
        ? structuredClone(record)
        : undefined;
    };
    return {
      repository: { getState: (type, id) => repository.getState(type, id), getIdempotency: read },
      unitOfWork: {
        commit: async (input) => {
          const plan = prepareTransaction(input, scope, now, "memory");
          const previous = tail;
          let unlock!: () => void;
          tail = new Promise<void>((resolve) => {
            unlock = resolve;
          });
          await previous;
          try {
            if (await read(plan.commit.idempotency!.key))
              throw new JawStackRuntimeError(
                "idempotency.conflict",
                "Idempotency key was already committed.",
              );
            const opKey = JSON.stringify(operationKey(plan.operation));
            if (operations.has(opKey))
              throw new JawStackRuntimeError(
                "resource.conflict",
                "Operation receipt already exists.",
              );
            const staged = new InMemoryStore();
            for (const [k, v] of store.resources) staged.resources.set(k, structuredClone(v));
            const { resource, activity, outbox, response } = plan.commit;
            await new InMemoryUnitOfWork(staged).commit({
              resource,
              activity,
              outbox,
              response,
              projections: [],
            });
            const projections = structuredClone(store.projections);
            for (const row of plan.commit.projections) {
              const k = JSON.stringify(projectionKey({ ...row, resourceType: scope.resourceType }));
              if (row.delete) projections.delete(k);
              else projections.set(k, row);
            }
            // Nothing below can fail or yield: publish all staged state and auxiliary records together.
            store.resources.clear();
            for (const [k, v] of staged.resources) store.resources.set(k, v);
            store.activity.push(...staged.activity);
            store.outbox.push(...staged.outbox);
            store.projections.clear();
            for (const [k, v] of projections) store.projections.set(k, v);
            operations.set(opKey, plan.operation);
            idempotency.set(key(plan.commit.idempotency!.key), {
              ...plan.commit.idempotency!,
              expiresAt: plan.expiresAt,
            });
          } finally {
            unlock();
          }
        },
      },
    };
  };
  return { factory, repository, store, operations, idempotency };
}
