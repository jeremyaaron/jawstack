import type { WorkflowDeliveryEvent } from "@jawstack/core";
import { createContentStorageSpec } from "../application/workflow";
import { contentEventSource } from "./event-policy";
import { contentEventSchemas } from "./contracts";
import type { z } from "zod";
export { contentEventSource, eventIdentitySchema } from "./event-policy";
type Payload = z.infer<(typeof contentEventSchemas)[keyof typeof contentEventSchemas]>;
export type ContentEvent = Omit<WorkflowDeliveryEvent, "payload"> & { payload: Payload };
export const parseContentWire = (input: unknown, source = contentEventSource) =>
  createContentStorageSpec(source).protocol.wire(input);
export function parseContentEvent(input: unknown, source = contentEventSource): ContentEvent {
  const wire = parseContentWire(input, source);
  const { delivery, ...payload } = wire.payload;
  const recovery = delivery as WorkflowDeliveryEvent["recovery"];
  return {
    ...wire,
    payload: payload as Payload,
    originalEventId: recovery?.originalEventId ?? wire.eventId,
    ...(recovery ? { recovery } : {}),
  };
}

export function contentDeliveryWire(event: ContentEvent) {
  const { originalEventId, recovery, ...wire } = event;
  void originalEventId;
  return {
    ...wire,
    payload: { ...wire.payload, ...(recovery ? { delivery: recovery } : {}) },
  };
}
