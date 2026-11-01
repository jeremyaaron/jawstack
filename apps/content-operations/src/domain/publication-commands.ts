import {
  defineCommand,
  JawStackRuntimeError,
  type CommandContext,
  type CommandDecision,
  type EventDraft,
  type ResourceState,
} from "@jawstack/core";
import {
  publicationAttemptView,
  publicationObjectKey,
  type ContentEventType,
  type ContentState,
  type PublicationAttempt,
  type PublicationState,
} from "../shared/contracts";
import {
  claimPublicationInput,
  completePublicationInput,
  failPublicationInput,
  scheduleReferenceInput,
  reconcilePublicationFailureInput,
} from "../shared/publication-inputs";
import { contentUi } from "../shared/presentation";
import { limits } from "../shared/validation";
import { publicationRecovery } from "../shared/publication-recovery";

export const publisherIdentity = Object.freeze({
  subject: "content_publisher",
  role: "contentPublisher",
});
export const dueWorkerIdentity = Object.freeze({ subject: "due_worker", role: "dueWorker" });
export const failureCollectorIdentity = Object.freeze({
  subject: "failure_collector",
  role: "failureCollector",
});
type Dependencies = {
  load(
    context: CommandContext,
    version: number,
    policy: "editor" | "publisher" | "dueWorker" | "collector",
  ): ResourceState<ContentState>;
  finish(
    context: CommandContext,
    previous: ResourceState<ContentState>,
    next: ContentState,
    event: ContentEventType,
    title: string,
    payload: unknown,
    extra?: readonly EventDraft[],
  ): CommandDecision;
  newId(context: CommandContext, previous: ContentState): string;
  fact(event: ContentEventType, payload: unknown): EventDraft;
};
const requireThat = (condition: unknown, message: string, conflict = false) => {
  if (!condition)
    throw new JawStackRuntimeError(conflict ? "resource.conflict" : "command.rejected", message);
};
export function createPublicationCommands(d: Dependencies) {
  const approved = (
    previous: ResourceState<ContentState>,
    input: { reviewId: string; revisionId: string },
  ) =>
    requireThat(
      previous.state.approval?.reviewId === input.reviewId &&
        previous.state.revisionId === input.revisionId,
      "Approval or revision is no longer current.",
      true,
    );
  const scheduled = (
    previous: ResourceState<ContentState>,
    input: { revisionId: string; scheduleGeneration: string },
  ) =>
    requireThat(
      previous.state.status === "scheduled" &&
        previous.state.revisionId === input.revisionId &&
        previous.state.schedule?.generation === input.scheduleGeneration,
      "Schedule is no longer current.",
      true,
    );
  const active = (
    previous: ResourceState<ContentState>,
    input: { publicationId: string; generation: number },
  ): PublicationState => {
    const publication = previous.state.publication;
    requireThat(
      previous.state.status === "publishing" &&
        publication?.intent.publicationId === input.publicationId &&
        publication.generation === input.generation,
      "Publication or generation is no longer active.",
      true,
    );
    return publication!;
  };
  const fenced = (
    previous: ResourceState<ContentState>,
    input: { publicationId: string; generation: number; attemptId: string; fencingToken: string },
    now: number,
  ) => {
    const publication = active(previous, input);
    requireThat(
      publication.phase === "running" &&
        publication.claim?.attemptId === input.attemptId &&
        publication.claim.fencingToken === input.fencingToken &&
        Date.parse(publication.claim.startedAt) <= now &&
        Date.parse(publication.claim.leaseUntil) > now,
      "Publication claim is stale or expired.",
      true,
    );
    return publication;
  };
  const attemptPayload = (
    previous: ResourceState<ContentState>,
    publication: PublicationState,
    attempt: PublicationAttempt,
  ) => ({
    contentId: previous.resourceId,
    publicationId: publication.intent.publicationId,
    sourceVersion: previous.version + 1,
    attempt: publicationAttemptView(attempt),
  });
  const requestPayload = (
    previous: ResourceState<ContentState>,
    publication: PublicationState,
  ) => ({
    contentId: previous.resourceId,
    publicationId: publication.intent.publicationId,
    generation: publication.generation,
    sourceVersion: previous.version + 1,
    intent: publication.intent,
  });
  const outcomePayload = (
    previous: ResourceState<ContentState>,
    publication: PublicationState,
  ) => ({
    contentId: previous.resourceId,
    publicationId: publication.intent.publicationId,
    generation: publication.generation,
    sourceVersion: previous.version + 1,
    revisionId: publication.intent.snapshot.revisionId,
    authorId: publication.intent.snapshot.authorId,
    title: publication.intent.snapshot.title,
    outcome: publication.phase === "succeeded" ? "published" : "failed",
    outcomeAt: publication.deliveryFailure?.at ?? publication.lastAttempt!.finishedAt!,
    artifact: publication.artifact,
    failureCode: publication.deliveryFailure
      ? "execution.interrupted"
      : (publication.lastAttempt?.failureCode ?? null),
  });
  const expire = (
    previous: ResourceState<ContentState>,
    publication: PublicationState,
    now: Date,
  ) => {
    if (!publication.claim) return [];
    const expired: PublicationAttempt = {
      ...publication.lastAttempt!,
      status: "expired",
      finishedAt: now.toISOString(),
      failureCode: null,
    };
    return [
      d.fact("contentItem.publicationLeaseExpired", attemptPayload(previous, publication, expired)),
    ];
  };
  const request = (context: CommandContext, previous: ResourceState<ContentState>) => {
    const publication: PublicationState = {
      intent: {
        publicationId: d.newId(context, previous.state),
        contentId: previous.resourceId,
        requestedAt: context.now.toISOString(),
        snapshot: previous.state.review!.submitted,
        approval: previous.state.approval!,
        schedule: previous.state.schedule,
      },
      generation: 1,
      phase: "queued",
      deliveryFailure: null,
      attemptsInGeneration: 0,
      claim: null,
      lastAttempt: null,
      artifact: null,
    };
    return d.finish(
      context,
      previous,
      { ...previous.state, status: "publishing", schedule: null, publication },
      "contentItem.publicationRequested",
      "Requested publication",
      requestPayload(previous, publication),
    );
  };
  return {
    ...Object.fromEntries(
      (["schedule", "reschedule"] as const).map((name) => [
        name,
        defineCommand({
          ...contentUi.commands[name],
          emits: [
            {
              eventType: name === "schedule" ? "contentItem.scheduled" : "contentItem.rescheduled",
              schemaVersion: 1,
            },
          ],
          decide: (context) => {
            const previous = d.load(context, context.input.expectedVersion, "editor");
            approved(previous, context.input);
            if (name === "schedule")
              requireThat(
                previous.state.status === "approved",
                "Only approved content can be scheduled.",
              );
            else
              scheduled(
                previous,
                context.input as typeof context.input & { scheduleGeneration: string },
              );
            if (Date.parse(context.input.scheduledAt) <= context.now.getTime())
              throw new JawStackRuntimeError(
                "command.validation",
                "Schedule time must be in the future.",
              );
            const schedule = {
              scheduledAt: context.input.scheduledAt,
              timeZone: context.input.timeZone,
              revisionId: previous.state.revisionId,
              generation: d.newId(context, previous.state),
            };
            const next: ContentState = { ...previous.state, status: "scheduled", schedule };
            return d.finish(
              context,
              previous,
              next,
              name === "schedule" ? "contentItem.scheduled" : "contentItem.rescheduled",
              name === "schedule" ? "Scheduled content" : "Rescheduled content",
              {
                contentId: previous.resourceId,
                revisionId: next.revisionId,
                sourceVersion: previous.version + 1,
                status: next.status,
                schedule,
              },
            );
          },
        }),
      ]),
    ),
    cancelSchedule: defineCommand({
      ...contentUi.commands.cancelSchedule,
      emits: [{ eventType: "contentItem.scheduleCancelled", schemaVersion: 1 }],
      decide: (context) => {
        const previous = d.load(context, context.input.expectedVersion, "editor");
        scheduled(previous, context.input);
        return d.finish(
          context,
          previous,
          { ...previous.state, status: "approved", schedule: null },
          "contentItem.scheduleCancelled",
          "Cancelled schedule",
          {
            contentId: previous.resourceId,
            revisionId: previous.state.revisionId,
            sourceVersion: previous.version + 1,
            status: "approved",
            schedule: null,
          },
        );
      },
    }),
    publishNow: defineCommand({
      ...contentUi.commands.publishNow,
      emits: [{ eventType: "contentItem.publicationRequested", schemaVersion: 1 }],
      decide: (context) => {
        const previous = d.load(context, context.input.expectedVersion, "editor");
        approved(previous, context.input);
        requireThat(
          ["approved", "scheduled"].includes(previous.state.status),
          "Only approved or scheduled content can publish.",
        );
        return request(context, previous);
      },
    }),
    requestDuePublication: defineCommand({
      title: "Request due publication",
      roles: [dueWorkerIdentity.role],
      input: scheduleReferenceInput,
      emits: [{ eventType: "contentItem.publicationRequested", schemaVersion: 1 }],
      decide: (context) => {
        const previous = d.load(context, context.input.expectedVersion, "dueWorker");
        scheduled(previous, context.input);
        requireThat(
          Date.parse(previous.state.schedule!.scheduledAt) <= context.now.getTime(),
          "Schedule is not due.",
        );
        return request(context, previous);
      },
    }),
    claimPublication: defineCommand({
      title: "Claim publication",
      roles: [publisherIdentity.role],
      input: claimPublicationInput,
      emits: [
        { eventType: "contentItem.publicationClaimed", schemaVersion: 1 },
        { eventType: "contentItem.publicationLeaseExpired", schemaVersion: 1 },
      ],
      decide: (context) => {
        const previous = d.load(context, context.input.expectedVersion, "publisher");
        const publication = active(previous, context.input);
        requireThat(
          publication.phase === "queued" || publication.phase === "running",
          "Publication cycle is terminal.",
        );
        requireThat(
          !publication.claim || Date.parse(publication.claim.leaseUntil) <= context.now.getTime(),
          "A publication claim is already active.",
          true,
        );
        requireThat(
          publication.attemptsInGeneration < limits.publicationAttempts,
          "Publication attempt budget exhausted; explicit retry is required.",
        );
        requireThat(
          context.input.attemptId !== publication.lastAttempt?.claim.attemptId &&
            ![
              previous.resourceId,
              previous.state.revisionId,
              publication.intent.publicationId,
              publication.claim?.fencingToken,
            ].includes(context.input.attemptId),
          "A fresh attempt UUID is required.",
          true,
        );
        const token = d.newId(context, previous.state);
        requireThat(
          token !== context.input.attemptId,
          "Fencing token must differ from attempt ID.",
        );
        const claim = {
          attemptId: context.input.attemptId,
          fencingToken: token,
          startedAt: context.now.toISOString(),
          leaseUntil: new Date(context.now.getTime() + limits.publicationLeaseMs).toISOString(),
        };
        const attempt: PublicationAttempt = {
          generation: publication.generation,
          claim,
          status: "claimed",
          finishedAt: null,
          failureCode: null,
          sourceEventId: context.requestId,
          correlationId: context.correlationId,
        };
        const next: PublicationState = {
          ...publication,
          phase: "running",
          attemptsInGeneration: publication.attemptsInGeneration + 1,
          claim,
          lastAttempt: attempt,
        };
        return d.finish(
          context,
          previous,
          { ...previous.state, publication: next },
          "contentItem.publicationClaimed",
          "Claimed publication",
          attemptPayload(previous, next, attempt),
          expire(previous, publication, context.now),
        );
      },
    }),
    completePublication: defineCommand({
      title: "Complete publication",
      roles: [publisherIdentity.role],
      input: completePublicationInput,
      emits: [
        { eventType: "contentItem.published", schemaVersion: 1 },
        { eventType: "contentItem.publicationAttemptSucceeded", schemaVersion: 1 },
      ],
      decide: (context) => {
        const previous = d.load(context, context.input.expectedVersion, "publisher");
        const publication = fenced(previous, context.input, context.now.getTime());
        requireThat(
          context.input.artifact.objectKey ===
            publicationObjectKey(previous.resourceId, publication.intent.publicationId),
          "Artifact key does not match publication intent.",
        );
        const attempt: PublicationAttempt = {
          ...publication.lastAttempt!,
          status: "succeeded",
          finishedAt: context.now.toISOString(),
        };
        const next: PublicationState = {
          ...publication,
          phase: "succeeded",
          claim: null,
          lastAttempt: attempt,
          artifact: { ...context.input.artifact, completedAt: context.now.toISOString() },
        };
        return d.finish(
          context,
          previous,
          { ...previous.state, status: "published", publication: next },
          "contentItem.published",
          "Completed publication",
          outcomePayload(previous, next),
          [
            d.fact(
              "contentItem.publicationAttemptSucceeded",
              attemptPayload(previous, next, attempt),
            ),
          ],
        );
      },
    }),
    failPublication: defineCommand({
      title: "Fail publication",
      roles: [publisherIdentity.role],
      input: failPublicationInput,
      emits: [
        { eventType: "contentItem.publicationAttemptFailed", schemaVersion: 1 },
        { eventType: "contentItem.publicationFailed", schemaVersion: 1 },
      ],
      decide: (context) => {
        const previous = d.load(context, context.input.expectedVersion, "publisher");
        const publication = fenced(previous, context.input, context.now.getTime());
        const terminal =
          ["artifact.mismatch", "snapshot.invalid"].includes(context.input.failureCode) ||
          publication.attemptsInGeneration >= limits.publicationAttempts;
        const attempt: PublicationAttempt = {
          ...publication.lastAttempt!,
          status: "failed",
          finishedAt: context.now.toISOString(),
          failureCode: context.input.failureCode,
        };
        const next: PublicationState = {
          ...publication,
          phase: terminal ? "failed" : "queued",
          claim: null,
          lastAttempt: attempt,
        };
        const payload = attemptPayload(previous, next, attempt);
        return d.finish(
          context,
          previous,
          { ...previous.state, publication: next },
          terminal ? "contentItem.publicationFailed" : "contentItem.publicationAttemptFailed",
          terminal ? "Publication cycle failed" : "Publication attempt failed",
          terminal ? outcomePayload(previous, next) : payload,
          terminal ? [d.fact("contentItem.publicationAttemptFailed", payload)] : [],
        );
      },
    }),
    reconcilePublicationFailure: defineCommand({
      title: "Reconcile exhausted publication delivery",
      roles: [failureCollectorIdentity.role],
      input: reconcilePublicationFailureInput,
      emits: [
        { eventType: "contentItem.publicationFailed", schemaVersion: 1 },
        { eventType: "contentItem.publicationLeaseExpired", schemaVersion: 1 },
      ],
      decide: (context) => {
        const previous = d.load(context, context.input.expectedVersion, "collector");
        const publication = active(previous, context.input);
        requireThat(
          !["failed", "stalled", "succeeded"].includes(publication.phase),
          "Publication is already terminal.",
          true,
        );
        requireThat(
          !publication.claim ||
            (publication.lastAttempt!.sourceEventId === context.input.sourceEventId &&
              Date.parse(publication.claim.leaseUntil) <= context.now.getTime()),
          "A matching publication claim is still live or changed.",
          true,
        );
        const expired = publication.claim
          ? {
              ...publication.lastAttempt!,
              status: "expired" as const,
              finishedAt: context.now.toISOString(),
              failureCode: null,
            }
          : publication.lastAttempt;
        const next: PublicationState = {
          ...publication,
          phase: "stalled",
          claim: null,
          lastAttempt: expired,
          deliveryFailure: {
            failureId: context.input.failureId,
            sourceEventId: context.input.sourceEventId,
            at: context.now.toISOString(),
          },
        };
        return d.finish(
          context,
          previous,
          { ...previous.state, publication: next },
          "contentItem.publicationFailed",
          "Publication delivery exhausted",
          outcomePayload(previous, next),
          expire(previous, publication, context.now),
        );
      },
    }),
    retryPublication: defineCommand({
      ...contentUi.commands.retryPublication,
      emits: [
        { eventType: "contentItem.publicationRetried", schemaVersion: 1 },
        { eventType: "contentItem.publicationLeaseExpired", schemaVersion: 1 },
      ],
      decide: (context) => {
        const previous = d.load(context, context.input.expectedVersion, "editor");
        const publication = active(previous, context.input);
        const recovery = publicationRecovery(publication, context.now.getTime());
        requireThat(!recovery.liveLease, "Cannot retry while a claim is active.", true);
        requireThat(
          recovery.hasRecoverableWork,
          "Only failed or stalled publication can be retried.",
        );
        requireThat(
          recovery.remainingGenerations > 0,
          "Manual publication retry budget exhausted.",
        );
        const expired = publication.claim
          ? {
              ...publication.lastAttempt!,
              status: "expired" as const,
              finishedAt: context.now.toISOString(),
              failureCode: null,
            }
          : publication.lastAttempt;
        const next: PublicationState = {
          ...publication,
          generation: publication.generation + 1,
          phase: "queued",
          deliveryFailure: null,
          attemptsInGeneration: 0,
          claim: null,
          lastAttempt: expired,
        };
        return d.finish(
          context,
          previous,
          { ...previous.state, publication: next },
          "contentItem.publicationRetried",
          "Retried publication",
          requestPayload(previous, next),
          expire(previous, publication, context.now),
        );
      },
    }),
  };
}
