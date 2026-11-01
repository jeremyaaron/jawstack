import { z } from "zod";
import { publicationAttemptViewSchema } from "./contracts";
import { eventIdentitySchema } from "./events";
import { fixtureIds, editorIds } from "./identities";
import { idSchema, instantSchema, versionSchema } from "./validation";

export const publicationOperationSchema = z.strictObject({
  kind: z.literal("publicationAttempt"),
  contentId: idSchema,
  publicationId: idSchema,
  attempt: publicationAttemptViewSchema,
  transitionEventId: eventIdentitySchema,
  causationId: eventIdentitySchema,
});
export type PublicationOperation = z.infer<typeof publicationOperationSchema>;
export const failureIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const consumerSchema = z.enum([
  "materializeReview",
  "materializeAsset",
  "deliverNotification",
  "publishContent",
]);
export const failureCollectionSchema = z
  .strictObject({
    generation: z.number().int().min(0).max(3),
    eventId: eventIdentitySchema,
    collectedAt: instantSchema,
    reconciledAt: instantSchema.nullable(),
    resolution: z.enum([
      "pending",
      "notApplicable",
      "stalled",
      "failed",
      "superseded",
      "succeeded",
    ]),
  })
  .refine((c) => (c.resolution === "pending") === (c.reconciledAt === null));
export const failureRecoverySchema = z.strictObject({
  generation: z.number().int().min(1).max(3),
  eventId: eventIdentitySchema,
  requestedAt: instantSchema,
  requestedBy: z.enum(editorIds),
  requestId: idSchema,
});
export const failureSummarySchema = z.object({
  id: failureIdSchema,
  version: versionSchema,
  consumer: consumerSchema,
  originalEventId: eventIdentitySchema,
  correlationId: eventIdentitySchema,
  eventType: z.string().min(1).max(200),
  resourceType: z.enum(["contentItem", "reviewTask", "asset"]),
  resourceId: idSchema,
  firstCollectedAt: instantSchema,
  generation: z.number().int().min(0).max(3),
  status: z.enum(["resolved", "replayQueued", "reconciling", "failed"]),
  resolution: failureCollectionSchema.shape.resolution.nullable(),
  recoveries: z.array(failureRecoverySchema).max(3),
  collections: z.array(failureCollectionSchema).max(4),
});
export type FailureSummary = z.infer<typeof failureSummarySchema>;
export const notificationViewSchema = z.strictObject({
  deliveryId: failureIdSchema,
  sourceEventId: eventIdentitySchema,
  transportEventId: eventIdentitySchema,
  eventType: z.enum([
    "contentItem.reviewReminderRecorded",
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
    "review-reminder.v1",
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
  payloadHash: failureIdSchema,
  occurredAt: instantSchema,
  deliveredAt: instantSchema,
  correlationId: eventIdentitySchema,
  causationId: eventIdentitySchema,
});
export type NotificationView = z.infer<typeof notificationViewSchema>;
