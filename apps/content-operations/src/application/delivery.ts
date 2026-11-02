import { createWorkflowDelivery, type WorkflowMarkerStore } from "@jawstack/core";
import type { ContentWorkerName } from "../domain/subscriptions";
import type { ContentEvent } from "../shared/events";
import { createContentWorkflow, createContentStorageSpec } from "./workflow";
import type { createFailureService } from "./failures";

// Adapter binding only: validation, markers, collection and replay completion are shared.
export function createContentDelivery(options: {
  source: string;
  markers: WorkflowMarkerStore;
  failures: Pick<
    ReturnType<typeof createFailureService>,
    "authorize" | "validateCollection" | "complete" | "collect"
  >;
  handle(name: ContentWorkerName, event: ContentEvent): Promise<unknown>;
  clock?: () => Date;
}) {
  const definition = createContentWorkflow(options.source);
  const spec = createContentStorageSpec(options.source);
  const delivery = createWorkflowDelivery({
    definition,
    markers: options.markers,
    failures: options.failures,
    clock: options.clock ?? (() => new Date()),
    signal: new AbortController().signal,
    run: async (work) => work(),
    bindings: new Map(
      spec.manifest.consumers.map((consumer) => [
        consumer.name,
        {
          handle: async (event) => {
            const result = await options.handle(
              consumer.name as ContentWorkerName,
              event as ContentEvent,
            );
            return result === "ignored" ? ("ignored" as const) : undefined;
          },
        },
      ]),
    ),
  });
  return { manifest: spec.manifest, delivery };
}
