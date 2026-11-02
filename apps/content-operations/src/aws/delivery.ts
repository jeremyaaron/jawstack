import { consumerSchema } from "../application/failure-records";
import type { ContentWorkerName } from "../domain/subscriptions";
import type { LabConfig } from "../lab/config";

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
