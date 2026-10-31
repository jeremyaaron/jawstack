import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  InMemoryRepository,
  InMemoryStore,
  JawStackRuntimeError,
  type Page,
  type ProjectionRecord,
  type ProjectionWrite,
} from "@jawstack/core";
import { projectionKey } from "@jawstack/aws-runtime";
import { eventIdentitySchema, type ContentEvent } from "../shared/events";
import { fixtureIds, type FixtureId } from "../shared/identities";
import { idSchema, instantSchema, jsonBytes } from "../shared/validation";
import { reviewTaskStateSchema, publicationOutcomeSchema } from "../shared/contracts";

export const notificationSchema = z
  .strictObject({
    deliveryId: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]+$/),
    sourceEventId: eventIdentitySchema,
    transportEventId: eventIdentitySchema,
    eventType: z.enum([
      "contentItem.reviewRequested",
      "contentItem.reviewDecided",
      "contentItem.published",
      "contentItem.publicationFailed",
    ]),
    contentId: idSchema,
    reviewId: idSchema.nullable(),
    publicationId: idSchema.optional(),
    recipientId: z.enum(fixtureIds),
    template: z.enum([
      "review-requested.v1",
      "review-approved.v1",
      "review-changes-requested.v1",
      "publication-succeeded.v1",
      "publication-failed.v1",
    ]),
    channel: z.literal("local"),
    status: z.literal("succeeded"),
    subject: z.string().min(1).max(220),
    message: z.string().min(1).max(1000),
    payloadHash: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]+$/),
    occurredAt: instantSchema,
    deliveredAt: instantSchema,
    correlationId: eventIdentitySchema,
    causationId: eventIdentitySchema,
  })
  .refine(
    (value) =>
      value.deliveryId === notificationId(value.sourceEventId, value.recipientId, value.template) &&
      jsonBytes(value) <= 8192 &&
      (value.eventType === "contentItem.published" ||
      value.eventType === "contentItem.publicationFailed"
        ? value.reviewId === null &&
          value.publicationId !== undefined &&
          value.template ===
            (value.eventType === "contentItem.published"
              ? "publication-succeeded.v1"
              : "publication-failed.v1")
        : value.reviewId !== null &&
          value.publicationId === undefined &&
          !value.template.startsWith("publication-")),
  );
export type NotificationDelivery = z.infer<typeof notificationSchema>;
export type NotificationQuery = Readonly<{
  recipientId?: FixtureId;
  limit?: number;
  cursor?: string;
}>;
export interface NotificationSink {
  deliver(delivery: NotificationDelivery): Promise<NotificationDelivery>;
  get(deliveryId: string): Promise<NotificationDelivery | undefined>;
  query(query?: NotificationQuery): Promise<Page<ProjectionRecord>>;
}
export function notificationId(eventId: string, recipientId: string, template: string) {
  return createHash("sha256")
    .update(JSON.stringify([eventId, recipientId, template]))
    .digest("hex");
}
export function renderNotification(event: ContentEvent, now: Date): NotificationDelivery {
  if (
    event.eventType === "contentItem.published" ||
    event.eventType === "contentItem.publicationFailed"
  ) {
    const outcome = publicationOutcomeSchema.parse(event.payload);
    const succeeded = outcome.outcome === "published";
    const template = succeeded ? "publication-succeeded.v1" : "publication-failed.v1";
    return notificationSchema.parse({
      deliveryId: notificationId(event.originalEventId, outcome.authorId, template),
      sourceEventId: event.originalEventId,
      transportEventId: event.eventId,
      eventType: event.eventType,
      contentId: outcome.contentId,
      reviewId: null,
      publicationId: outcome.publicationId,
      recipientId: outcome.authorId,
      template,
      channel: "local",
      status: "succeeded",
      subject: `${succeeded ? "Published" : "Publication failed"}: ${outcome.title}`,
      message: succeeded
        ? `Publication ${outcome.publicationId} completed.`
        : `Publication ${outcome.publicationId} requires recovery (${outcome.failureCode}).`,
      payloadHash: createHash("sha256")
        .update(
          JSON.stringify([
            event.source,
            event.resourceType,
            event.resourceId,
            event.eventType,
            event.payload,
          ]),
        )
        .digest("hex"),
      occurredAt: outcome.outcomeAt,
      deliveredAt: now.toISOString(),
      correlationId: event.correlationId,
      causationId: event.eventId,
    });
  }
  if (
    event.eventType !== "contentItem.reviewRequested" &&
    event.eventType !== "contentItem.reviewDecided"
  )
    throw new JawStackRuntimeError("command.rejected", "No notification template for this fact.");
  const review = reviewTaskStateSchema.parse(event.payload);
  const requested = event.eventType === "contentItem.reviewRequested";
  const template = requested
    ? "review-requested.v1"
    : review.status === "approved"
      ? "review-approved.v1"
      : "review-changes-requested.v1";
  const recipientId = requested ? review.assignedEditorId : review.submitted.authorId;
  return notificationSchema.parse({
    deliveryId: notificationId(event.originalEventId, recipientId, template),
    sourceEventId: event.originalEventId,
    transportEventId: event.eventId,
    eventType: event.eventType,
    contentId: review.contentId,
    reviewId: review.reviewId,
    recipientId,
    template,
    channel: "local",
    status: "succeeded",
    subject: `${requested ? "Review requested" : review.status === "approved" ? "Review approved" : "Changes requested"}: ${review.submitted.title}`,
    message: requested
      ? `Review ${review.reviewId} is due ${review.dueAt}.`
      : `Review ${review.reviewId} was ${review.status === "approved" ? "approved" : "returned for changes"}.`,
    payloadHash: createHash("sha256")
      .update(
        JSON.stringify([
          event.source,
          event.resourceType,
          event.resourceId,
          event.eventType,
          event.payload,
        ]),
      )
      .digest("hex"),
    occurredAt: requested ? review.submitted.submittedAt : review.decision!.at,
    deliveredAt: now.toISOString(),
    correlationId: event.correlationId,
    causationId: event.eventId,
  });
}
export function sameNotification(existing: NotificationDelivery, incoming: NotificationDelivery) {
  const business = (value: NotificationDelivery) => ({
    deliveryId: value.deliveryId,
    sourceEventId: value.sourceEventId,
    eventType: value.eventType,
    contentId: value.contentId,
    reviewId: value.reviewId,
    publicationId: value.publicationId,
    recipientId: value.recipientId,
    template: value.template,
    channel: value.channel,
    status: value.status,
    subject: value.subject,
    message: value.message,
    payloadHash: value.payloadHash,
    occurredAt: value.occurredAt,
  });
  if (!isDeepStrictEqual(business(existing), business(incoming)))
    throw new JawStackRuntimeError(
      "resource.conflict",
      "Notification identity was reused with different content.",
    );
  return structuredClone(existing);
}
export const notificationKey = (id: string) => ({ PK: `NOTIFICATION#${id}`, SK: "DELIVERY" });
export const notificationOperationKey = (id: string) => ({
  PK: "OPS#notificationDelivery",
  SK: id,
});
export function notificationOperation(delivery: NotificationDelivery) {
  return {
    kind: "notificationDelivery" as const,
    deliveryId: delivery.deliveryId,
    sourceEventId: delivery.sourceEventId,
    contentId: delivery.contentId,
    recipientId: delivery.recipientId,
    template: delivery.template,
    status: delivery.status,
    deliveredAt: delivery.deliveredAt,
    correlationId: delivery.correlationId,
    causationId: delivery.causationId,
  };
}
export function notificationProjections(delivery: NotificationDelivery): ProjectionWrite[] {
  return ["contentItem.notifications", `contentItem.notifications.${delivery.recipientId}`].map(
    (projectionName) => ({
      projectionName,
      itemId: delivery.deliveryId,
      sort: `${delivery.occurredAt}#${delivery.deliveryId}`,
      data: { ...delivery },
    }),
  );
}
export function notificationProjectionQuery(query: NotificationQuery = {}) {
  const parsed = z
    .strictObject({
      recipientId: z.enum(fixtureIds).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().min(1).max(8192).optional(),
    })
    .parse(query);
  return {
    projectionName: parsed.recipientId
      ? `contentItem.notifications.${parsed.recipientId}`
      : "contentItem.notifications",
    limit: parsed.limit ?? 50,
    ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
  };
}
export function createMemoryNotificationSink(
  options: { store?: InMemoryStore; maxDeliveries?: number } = {},
) {
  const store = options.store ?? new InMemoryStore();
  const repository = new InMemoryRepository(store);
  const deliveries = new Map<string, NotificationDelivery>();
  const operations = new Map<string, ReturnType<typeof notificationOperation>>();
  const maximum = options.maxDeliveries ?? 1000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 10_000)
    throw new Error("Invalid notification sink capacity.");
  const sink: NotificationSink = {
    get: async (id) => {
      const record = deliveries.get(id);
      return record && structuredClone(record);
    },
    query: async (query) => repository.queryProjection(notificationProjectionQuery(query)),
    deliver: async (input) => {
      const delivery = notificationSchema.parse(input);
      const previous = deliveries.get(delivery.deliveryId);
      if (previous) return sameNotification(previous, delivery);
      if (deliveries.size >= maximum)
        throw new JawStackRuntimeError(
          "runtime.unavailable",
          "Notification sink capacity reached.",
        );
      const operation = notificationOperation(delivery);
      const rows = notificationProjections(delivery).map((row) => ({
        row,
        key: JSON.stringify(projectionKey({ ...row, resourceType: "contentItem" })),
      }));
      if (operations.has(delivery.deliveryId) || rows.some(({ key }) => store.projections.has(key)))
        throw new JawStackRuntimeError(
          "resource.conflict",
          "Notification auxiliary record already exists.",
        );
      const staged = structuredClone({ delivery, operation, rows });
      // No await after checking conditions: publish the destination and its query/operation rows together.
      deliveries.set(delivery.deliveryId, staged.delivery);
      operations.set(delivery.deliveryId, staged.operation);
      for (const { key, row } of staged.rows) store.projections.set(key, row);
      return structuredClone(delivery);
    },
  };
  return { ...sink, store, deliveries, operations };
}
