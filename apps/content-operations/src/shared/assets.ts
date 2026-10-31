import { z } from "zod";
import { fixtureIds } from "./identities";
import {
  idSchema,
  instantSchema,
  jsonBytes,
  limits,
  validUnicode,
  versionSchema,
} from "./validation";

export const assetMediaTypes = ["image/png", "image/jpeg", "application/pdf"] as const;
export const assetStatuses = ["pending", "ready", "removed", "expired"] as const;
export const mediaTypeSchema = z.enum(assetMediaTypes);
export const assetSizeSchema = z.number().int().min(1).max(limits.assetBytes);
export const digestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .length(64);
export const filenameSchema = z
  .string()
  .min(1)
  .max(limits.filename)
  .refine(
    (value) =>
      validUnicode(value) &&
      value === value.trim() &&
      ![".", ".."].includes(value) &&
      !/[\p{Cc}/\\<>"\u2028-\u202e\u2066-\u2069]/u.test(value),
    "Filename must be safe display text, not a path or control sequence.",
  );
export function assetObjectKey(contentId: string, assetId: string) {
  idSchema.parse(contentId);
  idSchema.parse(assetId);
  return `assets/${contentId}/${assetId}/original`;
}
export const objectReferenceSchema = z
  .strictObject({
    contentId: idSchema,
    assetId: idSchema,
    objectKey: z.string().max(128),
    mediaType: mediaTypeSchema,
    size: assetSizeSchema,
    sha256: digestSchema,
  })
  .refine(
    (value) => value.objectKey === assetObjectKey(value.contentId, value.assetId),
    "Object key does not match its generated identity.",
  );
export type ObjectReference = z.infer<typeof objectReferenceSchema>;
export const readyAttachmentSchema = objectReferenceSchema.safeExtend({ filename: filenameSchema });
export type ReadyAttachment = z.infer<typeof readyAttachmentSchema>;
export const assetSlotSchema = z
  .strictObject({
    assetId: idSchema,
    contentId: idSchema,
    filename: filenameSchema,
    mediaType: mediaTypeSchema,
    expectedSize: assetSizeSchema,
    objectKey: z.string().max(128),
    uploaderId: z.enum(fixtureIds),
    registeredAt: instantSchema,
    uploadExpiresAt: instantSchema,
    status: z.enum(assetStatuses),
    verified: z
      .strictObject({ size: assetSizeSchema, sha256: digestSchema, at: instantSchema })
      .nullable(),
    retiredAt: instantSchema.nullable(),
    sourceVersion: versionSchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.objectKey !== assetObjectKey(value.contentId, value.assetId) ||
      value.assetId === value.contentId
    )
      ctx.addIssue({ code: "custom", message: "Invalid asset identity/key." });
    if (
      Date.parse(value.uploadExpiresAt) - Date.parse(value.registeredAt) !==
      limits.uploadLifetimeMs
    )
      ctx.addIssue({
        code: "custom",
        message: "Upload deadline must be one hour after registration.",
      });
    const retired = value.status === "removed" || value.status === "expired";
    if (
      retired !== (value.retiredAt !== null) ||
      (value.status === "ready" && !value.verified) ||
      (["pending", "expired"].includes(value.status) && value.verified)
    )
      ctx.addIssue({ code: "custom", message: "Asset lifecycle metadata mismatch." });
    if (
      value.verified &&
      (value.verified.size !== value.expectedSize ||
        Date.parse(value.verified.at) < Date.parse(value.registeredAt) ||
        Date.parse(value.verified.at) >= Date.parse(value.uploadExpiresAt))
    )
      ctx.addIssue({ code: "custom", message: "Invalid verified asset metadata." });
    if (
      value.retiredAt &&
      (Date.parse(value.retiredAt) < Date.parse(value.registeredAt) ||
        (value.verified && Date.parse(value.retiredAt) < Date.parse(value.verified.at)) ||
        (value.status === "expired" &&
          Date.parse(value.retiredAt) < Date.parse(value.uploadExpiresAt)))
    )
      ctx.addIssue({ code: "custom", message: "Invalid asset retirement time." });
  })
  .refine((value) => jsonBytes(value) <= limits.eventBytes)
  .readonly();
export type AssetSlot = z.infer<typeof assetSlotSchema>;
export const activeAsset = (slot: AssetSlot) =>
  slot.status === "pending" || slot.status === "ready";
export function readyAttachments(slots: readonly AssetSlot[]): ReadyAttachment[] {
  return slots
    .filter((slot) => slot.status === "ready")
    .map((slot) =>
      readyAttachmentSchema.parse({
        contentId: slot.contentId,
        assetId: slot.assetId,
        objectKey: slot.objectKey,
        filename: slot.filename,
        mediaType: slot.mediaType,
        size: slot.verified!.size,
        sha256: slot.verified!.sha256,
      }),
    )
    .sort((a, b) => a.assetId.localeCompare(b.assetId));
}
export const registerAssetInput = z.strictObject({
  expectedVersion: versionSchema,
  filename: filenameSchema,
  mediaType: mediaTypeSchema,
  expectedSize: assetSizeSchema,
});
export const assetVersionInput = z.strictObject({
  expectedVersion: versionSchema,
  assetId: idSchema,
});
export const completeUploadInput = assetVersionInput.extend({ object: objectReferenceSchema });
export const createAssetSnapshotInput = z.strictObject({ snapshot: assetSlotSchema });
export const applyAssetSnapshotInput = createAssetSnapshotInput.extend({
  expectedVersion: versionSchema,
});
