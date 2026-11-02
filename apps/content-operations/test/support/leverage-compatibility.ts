import { createHash } from "node:crypto";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { type CommandCommitInput, type JawStackEvent } from "@jawstack/core";
import {
  toOutboxEventItem,
  toProjectionItem,
  toWorkerIdempotencyItem,
} from "@jawstack/aws-runtime";
import { prepareTransaction, legacyComparableItems } from "./command-plan";
import { publicationOperationKey } from "../../src/application/publication-operations";
import {
  envelopeFingerprint,
  failedDeliveryId,
  failureKey,
  failureProjection,
  failureSummary,
  parseFailureRecord,
  replayEnvelope,
} from "../../src/application/failure-records";
import { parseContentWire } from "../../src/shared/events";
import { publicationOperationSchema, failureSummarySchema } from "../../src/shared/operation-views";

export function captureCompatibility() {
  const at = "2026-11-01T12:00:00.000Z";
  const id = "00000000-0000-4000-8000-000000000901";
  const review = "00000000-0000-4000-8000-000000000904";
  const revision = "00000000-0000-4000-8000-000000000905";
  const event: JawStackEvent = {
    envelopeVersion: 1,
    eventId: "event-review-1",
    eventType: "contentItem.reviewRequested",
    schemaVersion: 1,
    source: "content-operations",
    resourceType: "contentItem",
    resourceId: id,
    actor: { subject: "author_1", displayName: "Author One" },
    correlationId: "correlation-1",
    causationId: "request-1",
    occurredAt: at,
    payload: {
      contentId: id,
      reviewId: review,
      assignedEditorId: "editor_1",
      dueAt: "2026-11-02T12:00:00.000Z",
      lastReminderDay: null,
      decision: null,
      status: "pending",
      sourceVersion: 2,
      submitted: {
        contentId: id,
        revisionId: revision,
        authorId: "author_1",
        title: "Frozen compatibility",
        body: "Fixture body",
        attachments: [],
        submittedAt: at,
      },
    },
  };
  const wire = parseContentWire(event);
  const input: CommandCommitInput = {
    resource: {
      resourceType: "contentItem",
      resourceId: id,
      create: true,
      next: {
        resourceType: "contentItem",
        resourceId: id,
        version: 1,
        state: { title: "Fixture" },
        createdAt: at,
        updatedAt: at,
        createdBy: "author_1",
        updatedBy: "author_1",
      },
    },
    activity: [
      {
        activityId: "activity-1",
        resourceType: "contentItem",
        resourceId: id,
        activityType: "created",
        title: "Created",
        correlationId: "correlation-1",
        occurredAt: at,
      },
    ],
    outbox: [wire],
    projections: [
      { projectionName: "contentItem.list", itemId: id, sort: at, data: { title: "Fixture" } },
    ],
    response: { fixture: true },
    idempotency: {
      key: "fixture-key",
      fingerprint: "fixture-fingerprint",
      response: {
        ok: true,
        data: { fixture: true },
        meta: { requestId: "request-1", correlationId: "correlation-1" },
      },
    },
  };
  const plan = prepareTransaction(
    input,
    {
      resourceType: "contentItem",
      commandName: "create",
      subject: "author_1",
    },
    new Date(at),
    "compatibility-table",
  );
  const failureId = failedDeliveryId("deliverNotification", wire.eventId);
  const failure = parseFailureRecord(
    {
      id: failureId,
      version: 3,
      consumer: "deliverNotification",
      original: wire,
      fingerprint: envelopeFingerprint(wire),
      firstCollectedAt: at,
      collections: [
        {
          generation: 0,
          eventId: wire.eventId,
          collectedAt: at,
          reconciledAt: at,
          resolution: "notApplicable",
        },
      ],
      recoveries: [
        {
          generation: 1,
          eventId: "event-replay-1",
          requestedAt: "2026-11-01T12:01:00.000Z",
          requestedBy: "editor_1",
          requestId: "00000000-0000-4000-8000-000000000902",
        },
      ],
      resolvedGeneration: null,
    },
    event.source,
  );
  const replay = replayEnvelope(failure, failure.recoveries[0]!);
  const attempt = publicationOperationSchema.parse({
    kind: "publicationAttempt",
    contentId: id,
    publicationId: review,
    attempt: {
      generation: 1,
      claim: { attemptId: revision, startedAt: at, leaseUntil: "2026-11-01T12:01:30.000Z" },
      sourceEventId: "event-publication-1",
      correlationId: "correlation-1",
      status: "claimed",
      finishedAt: null,
      failureCode: null,
    },
    transitionEventId: "event-claim-1",
    causationId: "event-publication-1",
  });
  const summary = failureSummarySchema.parse(failureSummary(failure));
  return {
    fixtureVersion: 1,
    commandInput: input,
    transaction: legacyComparableItems(plan.items),
    decodedRows: plan.items.map((item) => unmarshall(item.Put!.Item!)),
    publicationAttempt: { record: attempt, key: publicationOperationKey(attempt) },
    wireJson: JSON.stringify(wire),
    fingerprint: envelopeFingerprint(wire),
    wireJsonSha256: createHash("sha256").update(JSON.stringify(wire)).digest("hex"),
    failure: {
      record: failure,
      key: failureKey(failureId),
      summary,
      projectionItem: toProjectionItem({
        ...failureProjection(failure),
        resourceType: "contentItem",
        resourceId: id,
        updatedAt: at,
      }),
    },
    replayJson: JSON.stringify(replay),
    replayOutboxItem: toOutboxEventItem(replay),
    markers: ["deliverNotification", "collectFailure.deliverNotification"].map((workerName) =>
      toWorkerIdempotencyItem({
        workerName,
        eventId: wire.eventId,
        processedAt: at,
        expiresAt: Math.floor(Date.parse(at) / 1000) + 604800,
      }),
    ),
  };
}
