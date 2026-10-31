import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { JawStackRuntimeError, type ResourceRepository } from "@jawstack/core";
import { assetSlotSchema } from "../shared/assets";
import { reviewTaskStateSchema } from "../shared/contracts";
import { contentEventSource, parseContentEvent, type ContentEvent } from "../shared/events";
import { instantSchema, versionSchema } from "../shared/validation";
import { assetProjectorIdentity } from "../domain/asset-resource";
import { reviewProjectorIdentity } from "../domain/resources";
import { contentWorkers, type ContentWorkerName } from "../domain/subscriptions";
import { renderNotification, type NotificationSink } from "./notifications";
import type { createContentDispatch } from "./dispatch";
import type { createPublisher } from "./publisher";

export function createContentWorkers(options: {
  repository: ResourceRepository;
  dispatch: ReturnType<typeof createContentDispatch>;
  notifications: NotificationSink;
  clock?: () => Date;
  source?: string;
  publisher?: ReturnType<typeof createPublisher>;
}) {
  const source = options.source ?? contentEventSource;
  if (!source.trim() || source.length > 200) throw new Error("Invalid application event source.");
  const subscribers = (eventType: string): ContentWorkerName[] =>
    contentWorkers
      .filter((worker) => worker.eventTypes.includes(eventType))
      .map((worker) => worker.name as ContentWorkerName);
  const materialize = async (
    name: "materializeReview" | "materializeAsset",
    event: ContentEvent,
  ) => {
    const review = name === "materializeReview";
    const resourceType = review ? "reviewTask" : "asset";
    const schema = review ? reviewTaskStateSchema : assetSlotSchema;
    const snapshot = schema.parse(event.payload);
    const targetId = "reviewId" in snapshot ? snapshot.reviewId : snapshot.assetId;
    const identity = review ? reviewProjectorIdentity : assetProjectorIdentity;
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = await options.repository.getState(resourceType, targetId);
      if (previous) {
        const parsed = schema.safeParse(previous.state);
        if (
          !parsed.success ||
          previous.resourceType !== resourceType ||
          previous.resourceId !== targetId ||
          !versionSchema.safeParse(previous.version).success ||
          !instantSchema.safeParse(previous.createdAt).success ||
          !instantSchema.safeParse(previous.updatedAt).success ||
          ("reviewId" in parsed.data ? parsed.data.reviewId : parsed.data.assetId) !== targetId
        )
          throw new JawStackRuntimeError(
            "resource.invalid_state",
            "Stored materialization is invalid.",
          );
        if (parsed.data.sourceVersion > snapshot.sourceVersion) return "ignored" as const;
        if (parsed.data.sourceVersion === snapshot.sourceVersion) {
          if (!isDeepStrictEqual(parsed.data, snapshot))
            throw new JawStackRuntimeError(
              "resource.conflict",
              "Equal source versions contain different snapshots.",
            );
          return "ignored" as const;
        }
      }
      const commandName = previous ? "applySnapshot" : "createSnapshot";
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            event.originalEventId,
            resourceType,
            targetId,
            snapshot.sourceVersion,
            previous?.version ?? null,
          ]),
        )
        .digest("hex");
      const result = await options.dispatch(
        {
          resourceType,
          resourceId: targetId,
          commandName,
          requestId: event.eventId,
          correlationId: event.correlationId,
          input: { snapshot, ...(previous ? { expectedVersion: previous.version } : {}) },
          idempotencyKey: `materialize:${key}`,
          requestContext: {},
        },
        { subject: identity.subject, roles: [identity.role], claims: {}, mode: "dev" },
      );
      if (result.ok) return "applied" as const;
      if (result.error.code !== "resource.conflict")
        throw new JawStackRuntimeError(result.error.code, result.error.message);
    }
    throw new JawStackRuntimeError(
      "resource.conflict",
      "Materialization exceeded its optimistic retry budget.",
    );
  };
  return {
    definitions: contentWorkers,
    subscribers,
    handle: async (name: ContentWorkerName, input: unknown) => {
      try {
        let event: ContentEvent;
        try {
          event = parseContentEvent(input, source);
        } catch {
          throw new JawStackRuntimeError(
            "command.validation",
            "Invalid application event envelope or payload.",
          );
        }
        if (!subscribers(event.eventType).includes(name))
          throw new JawStackRuntimeError(
            "command.rejected",
            "Worker is not subscribed to this fact.",
          );
        if (name === "publishContent") {
          if (!options.publisher)
            throw new JawStackRuntimeError(
              "runtime.unavailable",
              "Publication execution dependency is not configured.",
            );
          return await options.publisher(event);
        }
        if (name === "deliverNotification") {
          await options.notifications.deliver(
            renderNotification(event, options.clock?.() ?? new Date()),
          );
          return "delivered" as const;
        }
        return await materialize(name, event);
      } catch (error) {
        if (error instanceof JawStackRuntimeError) throw error;
        throw new JawStackRuntimeError(
          "runtime.unavailable",
          "Application worker dependency failed.",
        );
      }
    },
  };
}
