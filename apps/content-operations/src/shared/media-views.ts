import { z } from "zod";
import { assetSlotSchema, readyAttachmentSchema, digestSchema } from "./assets";
import { approvalSchema, scheduleSchema } from "./contracts";
import { idSchema, instantSchema, limits } from "./validation";

export const assetViewSchema = z.object(assetSlotSchema.unwrap().shape).omit({ objectKey: true });
export type AssetView = z.infer<typeof assetViewSchema>;
export const attachmentViewSchema = z.object(readyAttachmentSchema.shape).omit({ objectKey: true });
export type AttachmentView = z.infer<typeof attachmentViewSchema>;
export const publicationViewSchema = z.object({
  artifact: z.object({
    schemaVersion: z.literal(1),
    publicationId: idSchema,
    contentId: idSchema,
    requestedAt: instantSchema,
    approval: approvalSchema,
    schedule: scheduleSchema.nullable(),
    content: z.object({
      revisionId: idSchema,
      authorId: z.string(),
      title: z.string().max(limits.title),
      body: z.string(),
      submittedAt: instantSchema,
      attachments: z.array(attachmentViewSchema).max(limits.activeAssets),
    }),
  }),
  sha256: digestSchema,
  size: z.number().int().min(1).max(limits.publicationArtifactBytes),
  completedAt: instantSchema,
});
export type PublicationView = z.infer<typeof publicationViewSchema>;
