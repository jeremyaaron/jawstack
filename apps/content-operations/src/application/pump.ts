import {
  createMemoryWorkflowMarkers,
  createWorkflowPump,
  JawStackRuntimeError,
  type JawStackEvent,
} from "@jawstack/core";
import type { ContentWorkerName } from "../domain/subscriptions";
import type { createContentWorkers } from "./workers";
import type { createFailureService } from "./failures";
import { parseContentWire, contentEventSource, contentDeliveryWire } from "../shared/events";
import { createContentDelivery } from "./delivery";
export const workerMarkerTtlMs = 7 * 24 * 60 * 60 * 1000;
export function createMemoryPump(options: {
  outbox: () => readonly JawStackEvent[];
  workers: Pick<ReturnType<typeof createContentWorkers>, "subscribers" | "handle"> &
    Partial<Pick<ReturnType<typeof createContentWorkers>, "execute">>;
  clock?: () => Date;
  maxJobs?: number;
  maxMarkers?: number;
  source?: string;
  failures?: Pick<ReturnType<typeof createFailureService>, "collect"> &
    Partial<
      Pick<ReturnType<typeof createFailureService>, "authorize" | "validateCollection" | "complete">
    >;
}) {
  const maxJobs = options.maxJobs ?? 200,
    maxMarkers = options.maxMarkers ?? 1000;
  if ([maxJobs, maxMarkers].some((n) => !Number.isSafeInteger(n) || n < 1 || n > 10000))
    throw new Error("Invalid memory pump capacity.");
  const source = options.source ?? contentEventSource,
    clock = options.clock ?? (() => new Date());
  const unavailable = async (): Promise<never> => {
    throw new JawStackRuntimeError("runtime.unavailable", "Recovery is not configured.");
  };
  const markers = createMemoryWorkflowMarkers(maxMarkers, maxMarkers);
  const { delivery } = createContentDelivery({
    source,
    clock,
    markers,
    failures: {
      collect: options.failures?.collect ?? unavailable,
      authorize: options.failures?.authorize ?? unavailable,
      validateCollection: options.failures?.validateCollection ?? (async () => {}),
      complete: options.failures?.complete ?? unavailable,
    },
    handle:
      options.workers.execute ??
      ((name, event) => options.workers.handle(name, contentDeliveryWire(event))),
  });
  const pump = createWorkflowPump({
    outbox: options.outbox,
    parse: (input) => parseContentWire(input, source),
    subscribers: (type) => options.workers.subscribers(type),
    delivery,
    clock,
    signal: new AbortController().signal,
    maxJobs,
    markerCounts: () => markers.inspect(clock()),
    run: async (work) => work(),
    check: () => {},
  });
  return {
    drain: async (limit = 50) => pump.drain(limit),
    drainUntilIdle: pump.drainUntilIdle,
    stop: pump.stop,
    inspect: () => {
      const state = pump.inspect();
      return {
        ...state,
        markers: state.markers.delivery,
        jobs: state.jobs.map(({ consumer, ...job }) => ({
          ...job,
          worker: consumer as ContentWorkerName,
        })),
      };
    },
  };
}
