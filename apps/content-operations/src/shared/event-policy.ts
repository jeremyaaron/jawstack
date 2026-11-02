import { z } from "zod";
import { contentEventSchemas } from "./contracts";
import { idSchema } from "./validation";
import type { JawStackEvent } from "@jawstack/core";

export const contentEventSource = "content-operations";
export const eventIdentitySchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
export function validateContentFact(event: JawStackEvent<Record<string, unknown>>) {
  eventIdentitySchema.parse(event.eventId);
  eventIdentitySchema.parse(event.correlationId);
  if (event.causationId !== undefined) eventIdentitySchema.parse(event.causationId);
  if (event.actor) eventIdentitySchema.parse(event.actor.subject);
  const type = event.eventType as keyof typeof contentEventSchemas;
  const parsed = contentEventSchemas[type]?.parse(event.payload);
  if (!parsed) throw new Error("Unknown Content fact.");
  const id =
    event.resourceType === "reviewTask" && "reviewId" in parsed
      ? parsed.reviewId
      : event.resourceType === "asset" && "assetId" in parsed
        ? parsed.assetId
        : parsed.contentId;
  idSchema.parse(event.resourceId);
  if (event.resourceType !== event.eventType.split(".")[0] || event.resourceId !== id)
    throw new Error("Fact target does not match its envelope.");
}
