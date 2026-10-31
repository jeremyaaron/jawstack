import { defineWorker } from "@jawstack/core";

// Only implemented handlers are advertised; materializer outputs have no subscribers.
export const contentWorkers = [
  defineWorker({
    name: "materializeReview",
    eventTypes: [
      "contentItem.reviewRequested",
      "contentItem.reviewDecided",
      "contentItem.reviewSuperseded",
    ],
    maxConcurrency: 2,
  }),
  defineWorker({
    name: "materializeAsset",
    eventTypes: [
      "contentItem.assetRegistered",
      "contentItem.assetReady",
      "contentItem.assetRemoved",
      "contentItem.assetExpired",
    ],
    maxConcurrency: 2,
  }),
  defineWorker({
    name: "deliverNotification",
    eventTypes: [
      "contentItem.reviewRequested",
      "contentItem.reviewDecided",
      "contentItem.published",
      "contentItem.publicationFailed",
    ],
    maxConcurrency: 2,
  }),
  defineWorker({
    name: "publishContent",
    eventTypes: ["contentItem.publicationRequested", "contentItem.publicationRetried"],
    maxConcurrency: 2,
  }),
] as const;
export type ContentWorkerName =
  | "materializeReview"
  | "materializeAsset"
  | "deliverNotification"
  | "publishContent";
