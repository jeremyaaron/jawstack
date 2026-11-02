import { z } from "zod";
import { readyAttachmentSchema } from "./assets";
import { reviewTaskStateSchema, submittedSnapshotSchema } from "./contracts";
import { eventIdentitySchema } from "./event-policy";
import { idSchema, instantSchema } from "./validation";

// HTTP snapshots retain the domain's field contracts, but never storage references.
const attachment = readyAttachmentSchema.shape;
export const reviewViewSchema = z
  .object({
    ...reviewTaskStateSchema.unwrap().shape,
    submitted: z.object({
      ...submittedSnapshotSchema.unwrap().shape,
      attachments: z
        .array(
          z.object({
            assetId: attachment.assetId,
            contentId: attachment.contentId,
            filename: attachment.filename,
            mediaType: attachment.mediaType,
            size: attachment.size,
            sha256: attachment.sha256,
          }),
        )
        .max(10),
    }),
  })
  .refine(
    (review) => review.contentId === review.submitted.contentId,
    "Review target differs from its snapshot.",
  );
export type ReviewView = z.infer<typeof reviewViewSchema>;
export const activityViewSchema = z.object({
  activityId: eventIdentitySchema,
  resourceType: z.enum(["contentItem", "reviewTask", "asset"]),
  resourceId: idSchema,
  activityType: eventIdentitySchema,
  title: z.string().max(220),
  summary: z.string().max(1000).optional(),
  data: z.object({ revisionId: idSchema.optional(), reviewId: idSchema.optional() }).optional(),
  actor: z
    .object({ subject: eventIdentitySchema, displayName: z.string().max(200).optional() })
    .optional(),
  correlationId: eventIdentitySchema,
  causationId: eventIdentitySchema.optional(),
  occurredAt: instantSchema,
});
