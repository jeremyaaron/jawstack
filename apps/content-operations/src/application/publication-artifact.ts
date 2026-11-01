import { createHash } from "node:crypto";
import { JawStackRuntimeError } from "@jawstack/core";
import {
  publicationIntentSchema,
  publicationObjectKey,
  type PublicationIntent,
} from "../shared/contracts";
import { limits } from "../shared/validation";

export type PublicationObjectReference = Readonly<{
  objectKey: string;
  sha256: string;
  size: number;
}>;
export interface PublicationObjectStore {
  createPublication(intent: PublicationIntent): Promise<PublicationObjectReference>;
  readPublication(intent: PublicationIntent): Promise<Uint8Array>;
}
export class PublicationExecutionError extends JawStackRuntimeError {
  constructor(
    readonly failureCode: "artifact.mismatch" | "snapshot.invalid" | "storage.unavailable",
  ) {
    super(
      failureCode === "artifact.mismatch"
        ? "resource.conflict"
        : failureCode === "snapshot.invalid"
          ? "command.validation"
          : "runtime.unavailable",
      `Publication execution failed (${failureCode}).`,
    );
  }
}
export function serializePublication(input: PublicationIntent) {
  const parsed = publicationIntentSchema.safeParse(input);
  if (!parsed.success) throw new PublicationExecutionError("snapshot.invalid");
  const intent = parsed.data;
  const utc = (instant: string) => new Date(instant).toISOString();
  // Version 1 field order is part of the byte contract. Operational generations/claims are excluded.
  const artifact = {
    schemaVersion: 1,
    publicationId: intent.publicationId,
    contentId: intent.contentId,
    requestedAt: utc(intent.requestedAt),
    approval: {
      reviewId: intent.approval.reviewId,
      revisionId: intent.approval.revisionId,
      approvedBy: intent.approval.approvedBy,
      approvedAt: utc(intent.approval.approvedAt),
    },
    schedule: intent.schedule
      ? {
          scheduledAt: utc(intent.schedule.scheduledAt),
          generation: intent.schedule.generation,
          revisionId: intent.schedule.revisionId,
          timeZone: intent.schedule.timeZone,
        }
      : null,
    content: {
      revisionId: intent.snapshot.revisionId,
      authorId: intent.snapshot.authorId,
      title: intent.snapshot.title,
      body: intent.snapshot.body,
      submittedAt: utc(intent.snapshot.submittedAt),
      attachments: [...intent.snapshot.attachments]
        .sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0))
        .map((asset) => ({
          assetId: asset.assetId,
          contentId: asset.contentId,
          filename: asset.filename,
          mediaType: asset.mediaType,
          size: asset.size,
          sha256: asset.sha256,
          objectKey: asset.objectKey,
        })),
    },
  };
  const bytes = Buffer.from(`${JSON.stringify(artifact)}\n`, "utf8");
  if (bytes.length > limits.publicationArtifactBytes)
    throw new PublicationExecutionError("snapshot.invalid");
  const reference: PublicationObjectReference = {
    objectKey: publicationObjectKey(intent.contentId, intent.publicationId),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
  return { bytes, reference };
}
export function verifyPublicationBytes(intent: PublicationIntent, bytes: Uint8Array) {
  const expected = serializePublication(intent);
  if (
    bytes.byteLength !== expected.reference.size ||
    !Buffer.from(bytes).equals(expected.bytes) ||
    createHash("sha256").update(bytes).digest("hex") !== expected.reference.sha256
  )
    throw new PublicationExecutionError("artifact.mismatch");
  return expected.reference;
}
