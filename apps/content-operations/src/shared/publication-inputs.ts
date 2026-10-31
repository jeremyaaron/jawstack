import { z } from "zod";
import { idSchema, publicationFailureCodes, publicationGenerationSchema } from "./contracts";
import { digestSchema } from "./assets";
import { limits, timeZoneSchema, versionSchema } from "./validation";

export const approvalReferenceInput = z.strictObject({
  expectedVersion: versionSchema,
  reviewId: idSchema,
  revisionId: idSchema,
});
export const scheduleInput = approvalReferenceInput.extend({
  scheduledAt: z.iso
    .datetime({ offset: true, precision: 3 })
    .transform((value) => new Date(value).toISOString()),
  timeZone: timeZoneSchema,
});
export const rescheduleInput = scheduleInput.extend({ scheduleGeneration: idSchema });
export const scheduleReferenceInput = z.strictObject({
  expectedVersion: versionSchema,
  revisionId: idSchema,
  scheduleGeneration: idSchema,
});
export const publicationReferenceInput = z.strictObject({
  expectedVersion: versionSchema,
  publicationId: idSchema,
  generation: publicationGenerationSchema,
});
export const claimPublicationInput = publicationReferenceInput.extend({ attemptId: idSchema });
export const publicationFenceInput = claimPublicationInput.extend({ fencingToken: idSchema });
export const completePublicationInput = publicationFenceInput.extend({
  artifact: z.strictObject({
    objectKey: z.string().max(160),
    sha256: digestSchema,
    size: z.number().int().min(1).max(limits.publicationArtifactBytes),
  }),
});
export const failPublicationInput = publicationFenceInput.extend({
  failureCode: z.enum(publicationFailureCodes),
});
