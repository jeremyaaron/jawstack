import { z } from "zod";
import { editorIds, fixtureIds } from "./identities";

export const limits = Object.freeze({
  title: 160,
  bodyBytes: 32 * 1024,
  note: 2000,
  snapshotBytes: 64 * 1024,
  stateBytes: 160 * 1024,
  eventBytes: 80 * 1024,
});
export const jsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const idSchema = z.uuid();
export const versionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const instantSchema = z.iso.datetime({ precision: 3 });
const validUnicode = (value: string) =>
  new TextDecoder("utf-8", { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value;
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

// Slot/object protocols arrive in Phase 8; this schema intentionally accepts no fabricated assets.
const noAttachmentsSchema = z.array(z.never()).max(0).readonly();
export const submittedSnapshotSchema = z
  .strictObject({
    contentId: idSchema,
    revisionId: idSchema,
    authorId: z.enum(fixtureIds),
    title: titleSchema,
    body: bodySchema,
    attachments: noAttachmentsSchema,
    submittedAt: instantSchema,
  })
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

export const contentStateSchema = z
  .strictObject({
    contentId: idSchema,
    authorId: z.enum(fixtureIds),
    title: titleSchema,
    body: bodySchema,
    revisionId: idSchema,
    status: z.enum(contentStatuses),
    attachments: noAttachmentsSchema,
    review: reviewTaskStateSchema.nullable(),
    approval: z
      .strictObject({
        reviewId: idSchema,
        revisionId: idSchema,
        approvedBy: z.enum(editorIds),
        approvedAt: instantSchema,
      })
      .readonly()
      .nullable(),
    schedule: z
      .strictObject({
        scheduledAt: instantSchema,
        generation: idSchema,
        timeZone: z.string().min(1).max(100),
      })
      .readonly()
      .nullable(),
  })
  .superRefine((value, ctx) => {
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
    if (value.status === "inReview" || approved) {
      if (
        !review ||
        review.submitted.revisionId !== value.revisionId ||
        review.submitted.title !== value.title ||
        review.submitted.body !== value.body ||
        review.submitted.authorId !== value.authorId
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
} as const;
export type ContentEventType = keyof typeof contentEventSchemas;
