import { createWorkflowStorageSpec, defineWorkflow } from "@jawstack/core";
import { z } from "zod";
import { createContentOperationsResources } from "../domain/resources";
import { contentWorkers } from "../domain/subscriptions";
import { contentEventSchemas } from "../shared/contracts";
import { contentEventSource, validateContentFact } from "../shared/event-policy";
import { limits } from "../shared/validation";
import {
  commandReceiptRecord,
  publicationAttemptRecord,
  contributeContentCommand,
  idempotencyTtlSeconds,
  transactionActionLimit,
} from "./persistence";

export function createContentWorkflow(source = contentEventSource) {
  return defineWorkflow({
    name: "content-operations",
    source,
    resources: createContentOperationsResources(),
    commands: { idempotencyTtlSeconds, maxActions: transactionActionLimit },
    records: [commandReceiptRecord, publicationAttemptRecord],
    contribute: contributeContentCommand,
    events: Object.entries(contentEventSchemas).map(([eventType, schema]) => ({
      eventType,
      schemaVersion: 1,
      schema: schema instanceof z.ZodReadonly ? schema.unwrap() : schema,
      validateIdentity: (event) => {
        try {
          validateContentFact(event);
          return true;
        } catch {
          return false;
        }
      },
    })),
    eventBytes: limits.eventBytes,
    consumers: Object.fromEntries(
      contentWorkers.map(({ name }) => [
        name,
        { recovery: name === "publishContent" ? "application" : "replay" },
      ]),
    ),
    operations: { resourceType: "contentItem", projection: "contentItem.failures" },
  });
}
// One-entry cache avoids retaining arbitrary source names while sharing the immutable spec.
let current: { source: string; spec: ReturnType<typeof createWorkflowStorageSpec> } | undefined;
export function createContentStorageSpec(source = contentEventSource) {
  if (current?.source !== source)
    current = { source, spec: createWorkflowStorageSpec(createContentWorkflow(source)) };
  return current.spec;
}
