import { z } from "zod";
import { editorIds, fixtureIds } from "./identities";
import {
  activeAsset,
  assetSlotSchema,
  digestSchema,
  readyAttachmentSchema,
  readyAttachments,
} from "./assets";
import {
  idSchema,
  instantSchema,
  jsonBytes,
  limits,
  validUnicode,
  versionSchema,
  timeZoneSchema,
} from "./validation";
export { idSchema, instantSchema, jsonBytes, limits, versionSchema } from "./validation";
const titleInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(limits.title)
  .refine(validUnicode, "Text must be valid Unicode.");
const titleSchema = z
  .string()
  .min(1)
  .max(limits.title)
  .refine(
    (value) => value === value.trim() && validUnicode(value),
    "Stored titles must be canonical Unicode text.",
  );
const bodySchema = z
  .string()
  .refine(validUnicode, "Text must be valid Unicode.")
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= limits.bodyBytes,
    "Body exceeds 32 KiB UTF-8.",
  );
const noteSchema = z
  .string()
  .trim()
  .min(1)
  .max(limits.note)
  .refine(validUnicode, "Text must be valid Unicode.");
export const contentStatuses = [
  "draft",
  "inReview",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "archived",
] as const;
export const reviewStatuses = ["pending", "approved", "changesRequested", "superseded"] as const;

export const submittedSnapshotSchema = z
  .strictObject({
    contentId: idSchema,
    revisionId: idSchema,
    authorId: z.enum(fixtureIds),
    title: titleSchema,
    body: bodySchema,
    attachments: z.array(readyAttachmentSchema).max(limits.activeAssets).readonly(),
    submittedAt: instantSchema,
  })
  .refine(
    (value) =>
      value.attachments.every((asset) => asset.contentId === value.contentId) &&
      new Set(value.attachments.map((asset) => asset.assetId)).size === value.attachments.length,
    "Invalid submitted attachment references.",
  )
  .refine((value) => jsonBytes(value) <= limits.snapshotBytes, "Submitted snapshot exceeds 64 KiB.")
  .readonly();

export const reviewTaskStateSchema = z
  .strictObject({
    reviewId: idSchema,
    contentId: idSchema,
    assignedEditorId: z.enum(editorIds),
    dueAt: instantSchema,
    submitted: submittedSnapshotSchema,
    status: z.enum(reviewStatuses),
    sourceVersion: versionSchema,
    decision: z
      .strictObject({
        actorId: z.enum(fixtureIds),
        at: instantSchema,
        note: z
          .string()
          .max(limits.note)
          .refine(validUnicode, "Text must be valid Unicode.")
          .nullable(),
      })
      .readonly()
      .nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      value.contentId !== value.submitted.contentId ||
      Date.parse(value.dueAt) <= Date.parse(value.submitted.submittedAt)
    )
      ctx.addIssue({ code: "custom", message: "Invalid review reference or due time." });
    if ((value.status === "pending") !== (value.decision === null))
      ctx.addIssue({ code: "custom", message: "Review outcome/decision mismatch." });
    if (
      (value.status === "approved" || value.status === "changesRequested") &&
      (!value.decision ||
        !editorIds.some((id) => id === value.decision?.actorId) ||
        !value.decision.note?.trim())
    )
      ctx.addIssue({ code: "custom", message: "Editorial decisions require an editor and note." });
    if (value.decision && Date.parse(value.decision.at) < Date.parse(value.submitted.submittedAt))
      ctx.addIssue({ code: "custom", message: "Decision precedes submission." });
  })
  .refine((value) => jsonBytes(value) <= limits.eventBytes, "Review fact exceeds 80 KiB.")
  .readonly();

export const approvalSchema = z
  .strictObject({
    reviewId: idSchema,
    revisionId: idSchema,
    approvedBy: z.enum(editorIds),
    approvedAt: instantSchema,
  })
  .readonly();
export const scheduleSchema = z
  .strictObject({
    scheduledAt: instantSchema,
    generation: idSchema,
    revisionId: idSchema,
    timeZone: timeZoneSchema,
  })
  .readonly();
export const publicationGenerationSchema = z
  .number()
  .int()
  .min(1)
  .max(limits.publicationGenerations);
export const publicationFailureCodes = [
  "storage.unavailable",
  "execution.interrupted",
  "artifact.mismatch",
  "snapshot.invalid",
] as const;
export const publicationClaimSchema = z
  .strictObject({
    attemptId: idSchema,
    fencingToken: idSchema,
    startedAt: instantSchema,
    leaseUntil: instantSchema,
  })
  .refine(
    (value) =>
      value.attemptId !== value.fencingToken &&
      Date.parse(value.leaseUntil) - Date.parse(value.startedAt) === limits.publicationLeaseMs,
  )
  .readonly();
export const publicationAttemptSchema = z
  .strictObject({
    generation: publicationGenerationSchema,
    claim: publicationClaimSchema,
    status: z.enum(["claimed", "succeeded", "failed", "expired"]),
    finishedAt: instantSchema.nullable(),
    failureCode: z.enum(publicationFailureCodes).nullable(),
    sourceEventId: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => !/[^A-Za-z0-9_.:-]/.test(value)),
    correlationId: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => !/[^A-Za-z0-9_.:-]/.test(value)),
  })
  .superRefine((value, ctx) => {
    if (
      (value.status === "claimed") !== (value.finishedAt === null) ||
      (value.status === "failed") !== (value.failureCode !== null)
    )
      ctx.addIssue({ code: "custom", message: "Attempt outcome metadata mismatch." });
    if (
      value.finishedAt &&
      (Date.parse(value.finishedAt) < Date.parse(value.claim.startedAt) ||
        (value.status === "expired"
          ? Date.parse(value.finishedAt) < Date.parse(value.claim.leaseUntil)
          : Date.parse(value.finishedAt) >= Date.parse(value.claim.leaseUntil)))
    )
      ctx.addIssue({ code: "custom", message: "Attempt outcome is outside its lease." });
  })
  .readonly();
export const publicationIntentSchema = z
  .strictObject({
    publicationId: idSchema,
    contentId: idSchema,
    requestedAt: instantSchema,
    snapshot: submittedSnapshotSchema,
    approval: approvalSchema,
    schedule: scheduleSchema.nullable(),
  })
  .refine(
    (value) =>
      value.contentId === value.snapshot.contentId &&
      value.approval.revisionId === value.snapshot.revisionId &&
      Date.parse(value.approval.approvedAt) >= Date.parse(value.snapshot.submittedAt) &&
      Date.parse(value.requestedAt) >= Date.parse(value.approval.approvedAt) &&
      (!value.schedule || value.schedule.revisionId === value.snapshot.revisionId),
    "Publication intent does not match approval.",
  )
  .readonly();
export function publicationObjectKey(contentId: string, publicationId: string) {
  idSchema.parse(contentId);
  idSchema.parse(publicationId);
  return `publications/${contentId}/${publicationId}/snapshot.json`;
}
export const publicationArtifactSchema = z
  .strictObject({
    objectKey: z.string().max(160),
    sha256: digestSchema,
    size: z.number().int().min(1).max(limits.publicationArtifactBytes),
    completedAt: instantSchema,
  })
  .readonly();
export const publicationStateSchema = z
  .strictObject({
    intent: publicationIntentSchema,
    generation: publicationGenerationSchema,
    phase: z.enum(["queued", "running", "failed", "succeeded"]),
    attemptsInGeneration: z.number().int().min(0).max(limits.publicationAttempts),
    claim: publicationClaimSchema.nullable(),
    lastAttempt: publicationAttemptSchema.nullable(),
    artifact: publicationArtifactSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.phase === "running") !== (value.claim !== null) ||
      (value.phase === "succeeded") !== (value.artifact !== null)
    )
      ctx.addIssue({ code: "custom", message: "Publication phase/claim/artifact mismatch." });
    if (
      (value.phase !== "queued" && value.attemptsInGeneration === 0) ||
      (value.phase === "queued" &&
        value.attemptsInGeneration > 0 &&
        value.lastAttempt?.status !== "failed") ||
      (value.lastAttempt &&
        Date.parse(value.lastAttempt.claim.startedAt) < Date.parse(value.intent.requestedAt))
    )
      ctx.addIssue({ code: "custom", message: "Publication attempt lifecycle is inconsistent." });
    if (
      value.lastAttempt &&
      (value.lastAttempt.generation > value.generation ||
        (value.lastAttempt.generation === value.generation && value.attemptsInGeneration === 0))
    )
      ctx.addIssue({ code: "custom", message: "Attempt generation/count mismatch." });
    if (
      value.attemptsInGeneration > 0 &&
      (!value.lastAttempt || value.lastAttempt.generation !== value.generation)
    )
      ctx.addIssue({ code: "custom", message: "Missing current attempt." });
    if (
      value.claim &&
      (!value.lastAttempt ||
        value.lastAttempt.status !== "claimed" ||
        JSON.stringify(value.claim) !== JSON.stringify(value.lastAttempt.claim))
    )
      ctx.addIssue({ code: "custom", message: "Claim does not match current attempt." });
    if (!value.claim && value.lastAttempt?.status === "claimed")
      ctx.addIssue({ code: "custom", message: "Unfinished attempt has no claim." });
    if (value.phase === "failed" && value.lastAttempt?.status !== "failed")
      ctx.addIssue({ code: "custom", message: "Failed publication requires a failed attempt." });
    if (
      value.lastAttempt?.status === "failed" &&
      value.lastAttempt.generation === value.generation
    ) {
      const terminal =
        ["artifact.mismatch", "snapshot.invalid"].includes(value.lastAttempt.failureCode!) ||
        value.attemptsInGeneration >= limits.publicationAttempts;
      if ((value.phase === "failed") !== terminal)
        ctx.addIssue({
          code: "custom",
          message: "Publication failure classification is inconsistent.",
        });
    }
    if (
      value.artifact &&
      (value.lastAttempt?.status !== "succeeded" ||
        value.artifact.completedAt !== value.lastAttempt.finishedAt ||
        value.artifact.objectKey !==
          publicationObjectKey(value.intent.contentId, value.intent.publicationId))
    )
      ctx.addIssue({
        code: "custom",
        message: "Published artifact does not match intent/attempt.",
      });
  })
  .readonly();
export type PublicationIntent = z.infer<typeof publicationIntentSchema>;
export type PublicationAttempt = z.infer<typeof publicationAttemptSchema>;
export type PublicationState = z.infer<typeof publicationStateSchema>;
export const contentStateSchema = z
  .strictObject({
    contentId: idSchema,
    authorId: z.enum(fixtureIds),
    title: titleSchema,
    body: bodySchema,
    revisionId: idSchema,
    status: z.enum(contentStatuses),
    attachments: z.array(assetSlotSchema).max(limits.retainedAssets).readonly(),
    review: reviewTaskStateSchema.nullable(),
    approval: approvalSchema.nullable(),
    schedule: scheduleSchema.nullable(),
    publication: publicationStateSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      value.attachments.some((asset) => asset.contentId !== value.contentId) ||
      new Set(value.attachments.map((asset) => asset.assetId)).size !== value.attachments.length ||
      value.attachments.filter(activeAsset).length > limits.activeAssets
    )
      ctx.addIssue({ code: "custom", message: "Invalid or excessive attachment slots." });
    const review = value.review;
    if (review && review.contentId !== value.contentId)
      ctx.addIssue({ code: "custom", message: "Review belongs to different content." });
    if (value.status === "inReview" && review?.status !== "pending")
      ctx.addIssue({ code: "custom", message: "Review state requires a pending review." });
    if (value.status !== "inReview" && review?.status === "pending")
      ctx.addIssue({ code: "custom", message: "Pending review requires inReview content." });
    const approved = ["approved", "scheduled", "publishing", "published"].includes(value.status);
    if (approved && (!value.approval || review?.status !== "approved"))
      ctx.addIssue({ code: "custom", message: "Approved lifecycle state requires signoff." });
    if ((value.status === "draft" || value.status === "inReview") && value.approval)
      ctx.addIssue({ code: "custom", message: "Unapproved content cannot retain approval." });
    if (value.status === "inReview" || approved || value.publication) {
      if (
        !review ||
        review.submitted.revisionId !== value.revisionId ||
        review.submitted.title !== value.title ||
        review.submitted.body !== value.body ||
        review.submitted.authorId !== value.authorId ||
        value.attachments.some((slot) => slot.status === "pending") ||
        JSON.stringify(
          [...review.submitted.attachments].sort((a, b) => a.assetId.localeCompare(b.assetId)),
        ) !== JSON.stringify(readyAttachments(value.attachments))
      )
        ctx.addIssue({
          code: "custom",
          message: "Current content differs from its submitted snapshot.",
        });
    }
    if (
      value.approval &&
      (!review ||
        review.status !== "approved" ||
        value.approval.reviewId !== review.reviewId ||
        value.approval.revisionId !== review.submitted.revisionId ||
        value.approval.revisionId !== value.revisionId ||
        value.approval.approvedBy !== review.decision?.actorId ||
        value.approval.approvedAt !== review.decision?.at)
    )
      ctx.addIssue({ code: "custom", message: "Approval does not match the recorded review." });
    if ((value.status === "scheduled") !== (value.schedule !== null))
      ctx.addIssue({ code: "custom", message: "Schedule/status mismatch." });
    if (value.schedule && value.schedule.revisionId !== value.revisionId)
      ctx.addIssue({ code: "custom", message: "Schedule revision is obsolete." });
    const publication = value.publication;
    if (["publishing", "published"].includes(value.status) && !publication)
      ctx.addIssue({ code: "custom", message: "Publication lifecycle requires an intent." });
    if (
      publication &&
      (!value.approval ||
        !value.review ||
        !["publishing", "published", "archived"].includes(value.status) ||
        publication.intent.contentId !== value.contentId ||
        JSON.stringify(publication.intent.snapshot) !== JSON.stringify(value.review.submitted) ||
        JSON.stringify(publication.intent.approval) !== JSON.stringify(value.approval) ||
        (value.status === "publishing"
          ? publication.phase === "succeeded"
          : publication.phase !== "succeeded"))
    )
      ctx.addIssue({
        code: "custom",
        message: "Publication differs from authoritative approval/lifecycle.",
      });
  })
  .refine((value) => jsonBytes(value) <= limits.stateBytes, "Content state exceeds 160 KiB.")
  .readonly();

export type ContentState = z.infer<typeof contentStateSchema>;
export type ReviewTaskState = z.infer<typeof reviewTaskStateSchema>;
export const createContentInput = z.strictObject({ title: titleInputSchema, body: bodySchema });
export const editDraftInput = z.strictObject({
  expectedVersion: versionSchema,
  title: titleInputSchema,
  body: bodySchema,
});
export const submitInput = z.strictObject({
  expectedVersion: versionSchema,
  assignedEditorId: z.enum(editorIds),
  dueAt: instantSchema,
});
export const reviewDecisionInput = z.strictObject({
  expectedVersion: versionSchema,
  reviewId: idSchema,
  revisionId: idSchema,
  note: noteSchema,
});
export const versionInput = z.strictObject({ expectedVersion: versionSchema });
export const createReviewSnapshotInput = z.strictObject({ snapshot: reviewTaskStateSchema });
export const applyReviewSnapshotInput = z.strictObject({
  expectedVersion: versionSchema,
  snapshot: reviewTaskStateSchema,
});

const lifecycleFactSchema = z
  .strictObject({
    contentId: idSchema,
    authorId: z.enum(fixtureIds),
    revisionId: idSchema,
    title: titleSchema,
    status: z.enum(contentStatuses),
    sourceVersion: versionSchema,
  })
  .refine((value) => jsonBytes(value) <= limits.eventBytes, "Event exceeds 80 KiB.");
const scheduleFactSchema = z
  .strictObject({
    contentId: idSchema,
    revisionId: idSchema,
    sourceVersion: versionSchema,
    status: z.enum(["scheduled", "approved"]),
    schedule: scheduleSchema.nullable(),
  })
  .refine(
    (value) =>
      (value.status === "scheduled") === (value.schedule !== null) &&
      (!value.schedule || value.schedule.revisionId === value.revisionId),
  );
export const publicationRequestSchema = z
  .strictObject({
    contentId: idSchema,
    publicationId: idSchema,
    generation: publicationGenerationSchema,
    sourceVersion: versionSchema,
    intent: publicationIntentSchema,
  })
  .refine(
    (value) =>
      value.contentId === value.intent.contentId &&
      value.publicationId === value.intent.publicationId &&
      jsonBytes(value) <= limits.eventBytes,
  );
export const publicationAttemptViewSchema = z
  .strictObject({
    generation: publicationGenerationSchema,
    claim: z
      .strictObject({ attemptId: idSchema, startedAt: instantSchema, leaseUntil: instantSchema })
      .refine(
        (value) =>
          Date.parse(value.leaseUntil) - Date.parse(value.startedAt) === limits.publicationLeaseMs,
      ),
    status: z.enum(["claimed", "succeeded", "failed", "expired"]),
    finishedAt: instantSchema.nullable(),
    failureCode: z.enum(publicationFailureCodes).nullable(),
    sourceEventId: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => !/[^A-Za-z0-9_.:-]/.test(value)),
    correlationId: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => !/[^A-Za-z0-9_.:-]/.test(value)),
  })
  .refine(
    (value) =>
      (value.status === "claimed") === (value.finishedAt === null) &&
      (value.status === "failed") === (value.failureCode !== null) &&
      (!value.finishedAt ||
        (Date.parse(value.finishedAt) >= Date.parse(value.claim.startedAt) &&
          (value.status === "expired"
            ? Date.parse(value.finishedAt) >= Date.parse(value.claim.leaseUntil)
            : Date.parse(value.finishedAt) < Date.parse(value.claim.leaseUntil)))),
  );
export function publicationAttemptView(attempt: PublicationAttempt) {
  return publicationAttemptViewSchema.parse({
    ...attempt,
    claim: {
      attemptId: attempt.claim.attemptId,
      startedAt: attempt.claim.startedAt,
      leaseUntil: attempt.claim.leaseUntil,
    },
  });
}
export const publicationAttemptFactSchema = z.strictObject({
  contentId: idSchema,
  publicationId: idSchema,
  sourceVersion: versionSchema,
  attempt: publicationAttemptViewSchema,
});
const publicationOutcomeSchema = z
  .strictObject({
    contentId: idSchema,
    publicationId: idSchema,
    generation: publicationGenerationSchema,
    sourceVersion: versionSchema,
    revisionId: idSchema,
    authorId: z.enum(fixtureIds),
    title: titleSchema,
    outcome: z.enum(["published", "failed"]),
    artifact: publicationArtifactSchema.nullable(),
    failureCode: z.enum(publicationFailureCodes).nullable(),
  })
  .refine((value) =>
    value.outcome === "published"
      ? value.artifact?.objectKey === publicationObjectKey(value.contentId, value.publicationId) &&
        value.failureCode === null
      : value.artifact === null && value.failureCode !== null,
  );
export const contentEventSchemas = {
  "contentItem.created": lifecycleFactSchema.refine((value) => value.status === "draft"),
  "contentItem.draftEdited": lifecycleFactSchema.refine((value) => value.status === "draft"),
  "contentItem.reviewRequested": reviewTaskStateSchema.refine(
    (value) => value.status === "pending",
  ),
  "contentItem.reviewDecided": reviewTaskStateSchema.refine(
    (value) => value.status === "approved" || value.status === "changesRequested",
  ),
  "contentItem.reviewSuperseded": reviewTaskStateSchema.refine(
    (value) => value.status === "superseded",
  ),
  "contentItem.draftReopened": lifecycleFactSchema.refine((value) => value.status === "draft"),
  "contentItem.archived": lifecycleFactSchema.refine((value) => value.status === "archived"),
  "reviewTask.snapshotApplied": reviewTaskStateSchema,
  "contentItem.assetRegistered": assetSlotSchema.refine((value) => value.status === "pending"),
  "contentItem.assetReady": assetSlotSchema.refine((value) => value.status === "ready"),
  "contentItem.assetRemoved": assetSlotSchema.refine((value) => value.status === "removed"),
  "contentItem.assetExpired": assetSlotSchema.refine((value) => value.status === "expired"),
  "asset.snapshotApplied": assetSlotSchema,
  "contentItem.scheduled": scheduleFactSchema.refine((value) => value.status === "scheduled"),
  "contentItem.rescheduled": scheduleFactSchema.refine((value) => value.status === "scheduled"),
  "contentItem.scheduleCancelled": scheduleFactSchema.refine(
    (value) => value.status === "approved",
  ),
  "contentItem.publicationRequested": publicationRequestSchema.refine(
    (value) => value.generation === 1,
  ),
  "contentItem.publicationRetried": publicationRequestSchema.refine(
    (value) => value.generation > 1,
  ),
  "contentItem.publicationClaimed": publicationAttemptFactSchema.refine(
    (value) => value.attempt.status === "claimed",
  ),
  "contentItem.publicationAttemptSucceeded": publicationAttemptFactSchema.refine(
    (value) => value.attempt.status === "succeeded",
  ),
  "contentItem.publicationAttemptFailed": publicationAttemptFactSchema.refine(
    (value) => value.attempt.status === "failed",
  ),
  "contentItem.publicationLeaseExpired": publicationAttemptFactSchema.refine(
    (value) => value.attempt.status === "expired",
  ),
  "contentItem.publicationFailed": publicationOutcomeSchema.refine(
    (value) => value.outcome === "failed",
  ),
  "contentItem.published": publicationOutcomeSchema.refine(
    (value) => value.outcome === "published",
  ),
} as const;
export type ContentEventType = keyof typeof contentEventSchemas;
