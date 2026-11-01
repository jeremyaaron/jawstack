import { z } from "zod";
import { assetObjectKey } from "../shared/assets";
import { idSchema, instantSchema } from "../shared/validation";

export const cleanupTargetSchema = z.strictObject({ contentId: idSchema, assetId: idSchema });
export type CleanupTarget = z.infer<typeof cleanupTargetSchema>;
export const objectObservationSchema = z.strictObject({
  lastModified: instantSchema,
  etag: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\x20-\x7e]+$/)
    .refine((value) => value !== "*" && value !== '"*"'),
});
export type ObjectObservation = z.infer<typeof objectObservationSchema>;
export interface AssetCleanupStore {
  inspectAssetObject(target: CleanupTarget): Promise<ObjectObservation | undefined>;
  deleteAssetObject(
    target: CleanupTarget,
    observed: ObjectObservation,
    olderThan: string,
  ): Promise<boolean>;
}
export const cleanupObjectKey = (target: CleanupTarget) => {
  const parsed = cleanupTargetSchema.parse(target);
  return assetObjectKey(parsed.contentId, parsed.assetId);
};
