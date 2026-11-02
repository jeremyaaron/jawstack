import { createContentDispatch } from "./dispatch";
import { createMemoryPersistence } from "./memory";
import { createMemoryObjectStore } from "./object-store";
import { createUploadService } from "./uploads";
import { createMemoryNotificationSink } from "./notifications";
import { createContentWorkers } from "./workers";
import { createMemoryPump } from "./pump";
import { instantSchema } from "../shared/validation";
import { contentEventSource } from "../shared/events";
import { createPublisher } from "./publisher";
import { createMemoryJobStore } from "./job-store";
import { createContentJobs } from "./jobs";
import { createMemoryFailureStore } from "./failure-records";
import { createFailureService } from "./failures";

export function createFixtureClock(instant: string) {
  let value = Date.parse(instantSchema.parse(instant));
  return {
    now: () => new Date(value),
    advance: (milliseconds: number) => {
      if (
        !Number.isSafeInteger(milliseconds) ||
        milliseconds < 0 ||
        !Number.isFinite(new Date(value + milliseconds).getTime())
      )
        throw new Error("Invalid clock advance.");
      value += milliseconds;
    },
  };
}
export function createMemoryRuntime(options: { clock?: () => Date; source?: string } = {}) {
  const clock = options.clock ?? (() => new Date());
  const source = options.source ?? contentEventSource;
  const persistence = createMemoryPersistence({ source });
  const dispatch = createContentDispatch({ persistence: persistence.factory, clock, source });
  const objects = createMemoryObjectStore({ clock });
  const upload = createUploadService({
    repository: persistence.repository,
    dispatch,
    objects,
    clock,
  });
  const notifications = createMemoryNotificationSink({ store: persistence.store });
  const failureStore = createMemoryFailureStore({ source, store: persistence.store });
  const failures = createFailureService({
    store: failureStore,
    repository: persistence.repository,
    dispatch,
    clock,
    source,
  });
  const publisher = createPublisher({
    repository: persistence.repository,
    dispatch,
    objects,
    clock,
  });
  const workers = createContentWorkers({
    repository: persistence.repository,
    dispatch,
    notifications,
    clock,
    source,
    publisher,
    recovery: failures,
  });
  const pump = createMemoryPump({
    outbox: () => persistence.store.outbox,
    workers,
    clock,
    source,
    failures,
  });
  const jobStore = createMemoryJobStore();
  const jobs = createContentJobs({
    repository: persistence.repository,
    dispatch,
    store: jobStore,
    objects,
    clock,
  });
  const drainUntilIdle = async (maxPasses = 20) => {
    if (!Number.isInteger(maxPasses) || maxPasses < 1 || maxPasses > 100)
      throw new Error("Invalid drain pass budget.");
    for (let pass = 0; pass < maxPasses; pass++) {
      const result = await pump.drain();
      if (!result.hasMore || result.backpressured) return result;
    }
    throw new Error("Memory drain exceeded its pass budget.");
  };
  return {
    persistence,
    dispatch,
    objects,
    upload,
    notifications,
    workers,
    pump,
    jobStore,
    jobs,
    failureStore,
    failures,
    drainUntilIdle,
  };
}
