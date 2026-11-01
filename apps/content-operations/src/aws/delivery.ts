import { z } from "zod";
import type { SqsEvent } from "@jawstack/aws-runtime";
import { JawStackRuntimeError } from "@jawstack/core";
import { parseContentEvent, parseContentWire } from "../shared/events";
import { limits } from "../shared/validation";
import { assertSubscription, consumerSchema } from "../application/failure-records";
import type { ContentWorkerName } from "../domain/subscriptions";
import type { LabConfig } from "../lab/config";
export const deliveryMarkerTtlSeconds = 7 * 24 * 60 * 60;

export function deliveryQueueName(config: LabConfig, consumer: ContentWorkerName, dlq = false) {
  consumerSchema.parse(consumer);
  const suffixes = {
    materializeReview: "review",
    materializeAsset: "asset",
    deliverNotification: "notification",
    publishContent: "publication",
  };
  return `${config.project}-${suffixes[consumer]}${dlq ? "-dlq" : ""}`;
}
export function validatedDeliveryBatch(
  input: SqsEvent,
  options: {
    queueArn: string;
    consumer: ContentWorkerName;
    source: string;
    allowForeignRecovery?: boolean;
  },
) {
  try {
    const maximum = limits.eventBytes * 2 + 16384;
    const batch = z
      .object({
        Records: z
          .array(
            z.object({
              messageId: z.string().min(1).max(128),
              body: z.string().max(maximum),
              eventSourceARN: z.literal(options.queueArn),
            }),
          )
          .min(1)
          .max(10),
      })
      .parse(input);
    for (const record of batch.Records) {
      if (Buffer.byteLength(record.body) > maximum)
        throw new Error("Delivery transport byte budget exceeded.");
      const decoded: unknown = JSON.parse(record.body);
      let candidate = decoded;
      if (typeof decoded === "object" && decoded !== null && "detail" in decoded) {
        const outer = decoded as Record<string, unknown>;
        candidate = typeof outer.detail === "string" ? JSON.parse(outer.detail) : outer.detail;
        const event = parseContentEvent(candidate, options.source);
        if (
          (outer.source !== undefined && outer.source !== options.source) ||
          (outer["detail-type"] !== undefined && outer["detail-type"] !== event.eventType)
        )
          throw new Error("Delivery transport source/type mismatch.");
      }
      assertSubscription(
        options.consumer,
        parseContentEvent(candidate, options.source),
        options.allowForeignRecovery,
      );
      record.body = JSON.stringify(parseContentWire(candidate, options.source));
    }
    return batch;
  } catch (error) {
    if (error instanceof JawStackRuntimeError) throw error;
    throw new JawStackRuntimeError("command.validation", "Invalid application delivery batch.");
  }
}
