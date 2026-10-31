import { z } from "zod";
import { contentEventSchemas } from "./contracts";
import { idSchema, instantSchema, jsonBytes, limits } from "./validation";

export const contentEventSource = "content-operations";
export const eventIdentitySchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !/[^A-Za-z0-9_.:-]/.test(value));
const envelopeSchema = z.strictObject({
  envelopeVersion: z.literal(1),
  eventId: eventIdentitySchema,
  eventType: z.enum(
    Object.keys(contentEventSchemas) as [
      keyof typeof contentEventSchemas,
      ...Array<keyof typeof contentEventSchemas>,
    ],
  ),
  schemaVersion: z.literal(1),
  source: z.string().min(1).max(200),
  resourceType: z.enum(["contentItem", "reviewTask", "asset"]),
  resourceId: idSchema,
  actor: z
    .strictObject({ subject: eventIdentitySchema, displayName: z.string().max(200).optional() })
    .optional(),
  correlationId: eventIdentitySchema,
  causationId: eventIdentitySchema.optional(),
  occurredAt: instantSchema,
  payload: z.unknown(),
});
export const replayMetadataSchema = z.strictObject({
  originalEventId: eventIdentitySchema,
  generation: z.number().int().min(1).max(3),
});

export function parseContentEvent(input: unknown, source = contentEventSource) {
  const envelope = envelopeSchema.parse(input);
  if (envelope.source !== source) throw new Error("Unexpected application event source.");
  if (jsonBytes(envelope.payload) > limits.eventBytes + 512)
    throw new Error("Event payload exceeds its budget.");
  if (
    typeof envelope.payload !== "object" ||
    envelope.payload === null ||
    Array.isArray(envelope.payload)
  )
    throw new Error("Invalid fact payload.");
  const { delivery, ...payload } = envelope.payload as Record<string, unknown>;
  const replay = delivery === undefined ? undefined : replayMetadataSchema.parse(delivery);
  const parsed = contentEventSchemas[envelope.eventType].parse(payload);
  const resourceType = envelope.eventType.split(".")[0];
  const resourceId =
    envelope.resourceType === "reviewTask" && "reviewId" in parsed
      ? parsed.reviewId
      : envelope.resourceType === "asset" && "assetId" in parsed
        ? parsed.assetId
        : parsed.contentId;
  if (envelope.resourceType !== resourceType || envelope.resourceId !== resourceId)
    throw new Error("Fact target does not match its envelope.");
  return {
    ...envelope,
    payload: parsed,
    originalEventId: replay?.originalEventId ?? envelope.eventId,
  };
}
export type ContentEvent = ReturnType<typeof parseContentEvent>;
