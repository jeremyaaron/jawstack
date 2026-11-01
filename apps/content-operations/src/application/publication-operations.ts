import { isDeepStrictEqual } from "node:util";
import {
  JawStackRuntimeError,
  type CommandCommitInput,
  type ProjectionWrite,
} from "@jawstack/core";
import {
  contentStateSchema,
  publicationAttemptFactSchema,
  publicationAttemptView,
} from "../shared/contracts";
import { publicationOperationSchema, type PublicationOperation } from "../shared/operation-views";
export { publicationOperationSchema, type PublicationOperation } from "../shared/operation-views";

const stages = {
  "contentItem.publicationClaimed": "claimed",
  "contentItem.publicationAttemptSucceeded": "succeeded",
  "contentItem.publicationAttemptFailed": "failed",
  "contentItem.publicationLeaseExpired": "expired",
} as const;
export function publicationOperationKey(record: PublicationOperation) {
  return {
    PK: "OPS#publicationAttempt",
    SK: `${record.contentId}#${record.publicationId}#${record.attempt.claim.attemptId}#${record.attempt.status}`,
  };
}
export function publicationOperations(
  input: CommandCommitInput,
  command: string,
): PublicationOperation[] {
  const events = input.outbox.filter((event) => Object.hasOwn(stages, event.eventType));
  if (
    !events.length &&
    !["claimPublication", "completePublication", "failPublication"].includes(command)
  )
    return [];
  const allowed =
    command === "claimPublication"
      ? ["claimed", "expired"]
      : command === "completePublication"
        ? ["succeeded"]
        : command === "failPublication"
          ? ["failed"]
          : command === "retryPublication" || command === "reconcilePublicationFailure"
            ? ["expired"]
            : [];
  const parsed = contentStateSchema.safeParse(input.resource.next.state);
  if (
    !events.length ||
    events.length > 2 ||
    !parsed.success ||
    !parsed.data.publication ||
    input.resource.resourceType !== "contentItem"
  )
    throw new JawStackRuntimeError(
      "runtime.internal",
      "Missing or invalid publication operation facts.",
    );
  const publication = parsed.data.publication;
  return events.map((event) => {
    const fact = publicationAttemptFactSchema.parse(event.payload);
    const stage = stages[event.eventType as keyof typeof stages];
    if (
      !allowed.includes(stage) ||
      stage !== fact.attempt.status ||
      fact.contentId !== input.resource.resourceId ||
      fact.publicationId !== publication.intent.publicationId ||
      fact.sourceVersion !== input.resource.next.version ||
      (stage !== "expired" &&
        !isDeepStrictEqual(fact.attempt, publicationAttemptView(publication.lastAttempt!))) ||
      (stage === "expired" &&
        (fact.attempt.generation > publication.generation ||
          fact.attempt.finishedAt !== input.resource.next.updatedAt))
    )
      throw new JawStackRuntimeError(
        "runtime.internal",
        "Publication operation does not match its transition.",
      );
    return publicationOperationSchema.parse({
      kind: "publicationAttempt",
      contentId: fact.contentId,
      publicationId: fact.publicationId,
      attempt: fact.attempt,
      transitionEventId: event.eventId,
      causationId: event.causationId,
    });
  });
}
export function publicationOperationProjections(
  records: readonly PublicationOperation[],
): ProjectionWrite[] {
  return records.flatMap((record) =>
    ["contentItem.publicationAttempts", `contentItem.publicationAttempts.${record.contentId}`].map(
      (projectionName) => ({
        projectionName,
        itemId: record.attempt.claim.attemptId,
        sort: `${record.attempt.claim.startedAt}#${record.attempt.claim.attemptId}`,
        data: { ...record },
      }),
    ),
  );
}
