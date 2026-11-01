import { JawStackRuntimeError, type AuthContext, type ResourceRepository } from "@jawstack/core";
import { fixtureIdentities } from "../shared/identities";
import { assetSlotSchema, type AssetSlot, type ObjectReference } from "../shared/assets";
import { contentStateSchema } from "../shared/contracts";
import { idSchema, instantSchema, limits, versionSchema } from "../shared/validation";
import { uploadVerifierIdentity } from "../domain/resources";
import {
  readBoundedBytes,
  inspectAsset,
  type AssetObjectStore,
  type ByteSource,
} from "./object-store";
import type { createContentDispatch } from "./dispatch";

export function createUploadService(options: {
  repository: ResourceRepository;
  dispatch: ReturnType<typeof createContentDispatch>;
  objects: AssetObjectStore;
  clock?: () => Date;
  timeoutMs?: number;
}) {
  let active = 0;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new Error("Invalid upload timeout.");
  return async (request: {
    contentId: string;
    assetId: string;
    identity: AuthContext;
    body: ByteSource;
    signal?: AbortSignal;
  }): Promise<AssetSlot> => {
    const { contentId, assetId, body } = request;
    const identity = structuredClone(request.identity);
    if (active >= 2)
      throw new JawStackRuntimeError(
        "runtime.unavailable",
        "Upload concurrency limit reached; retry later.",
      );
    active++;
    const signal = AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(request.signal ? [request.signal] : []),
    ]);
    try {
      if (!idSchema.safeParse(contentId).success || !idSchema.safeParse(assetId).success)
        throw new JawStackRuntimeError("command.validation", "Invalid upload target IDs.");
      const load = async () => {
        signal.throwIfAborted();
        const previous = await options.repository.getState("contentItem", contentId);
        if (!previous)
          throw new JawStackRuntimeError("resource.not_found", "Content was not found.");
        const parsed = contentStateSchema.safeParse(previous.state);
        if (
          !parsed.success ||
          parsed.data.contentId !== contentId ||
          previous.resourceType !== "contentItem" ||
          previous.resourceId !== contentId ||
          !versionSchema.safeParse(previous.version).success ||
          !instantSchema.safeParse(previous.createdAt).success ||
          !instantSchema.safeParse(previous.updatedAt).success ||
          parsed.data.attachments.some((slot) => slot.sourceVersion > previous.version)
        )
          throw new JawStackRuntimeError("resource.invalid_state", "Stored content is invalid.");
        const fixture = fixtureIdentities.find((actor) => actor.subject === identity.subject);
        if (
          !fixture ||
          !["dev", "test"].includes(identity.mode) ||
          !fixture.roles.some((role) => identity.roles.includes(role)) ||
          (!fixture.roles.some((role) => role === "editor" && identity.roles.includes(role)) &&
            identity.subject !== parsed.data.authorId)
        )
          throw new JawStackRuntimeError(
            "auth.forbidden",
            "This identity cannot upload to this content.",
          );
        const slot = parsed.data.attachments.find((asset) => asset.assetId === assetId);
        if (parsed.data.status !== "draft" || !slot || !["pending", "ready"].includes(slot.status))
          throw new JawStackRuntimeError(
            "command.rejected",
            "Upload requires an active draft attachment.",
          );
        if (
          slot.status === "pending" &&
          (options.clock?.() ?? new Date()).getTime() >= Date.parse(slot.uploadExpiresAt)
        )
          throw new JawStackRuntimeError("command.rejected", "Upload slot has expired.");
        return { previous, slot };
      };
      const initial = await load();
      const bytes = await readBoundedBytes(
        body,
        Math.min(limits.assetBytes, initial.slot.expectedSize),
        signal,
      );
      const object = inspectAsset(initial.slot, bytes);
      const sameReady = (slot: AssetSlot, ref: ObjectReference) =>
        slot.status === "ready" &&
        slot.objectKey === ref.objectKey &&
        slot.mediaType === ref.mediaType &&
        slot.verified?.size === ref.size &&
        slot.verified.sha256 === ref.sha256;
      if (initial.slot.status === "ready") {
        if (!sameReady(initial.slot, object))
          throw new JawStackRuntimeError(
            "resource.conflict",
            "Ready attachment bytes cannot change.",
          );
        await options.objects.read(object);
        const current = await load();
        if (!sameReady(current.slot, object))
          throw new JawStackRuntimeError(
            "resource.conflict",
            "Attachment changed during verification.",
          );
        return current.slot;
      }
      // Recheck after consuming the stream, before any object creation.
      await load();
      await options.objects.create(initial.slot, bytes);
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await load();
        if (current.slot.status === "ready") {
          if (!sameReady(current.slot, object))
            throw new JawStackRuntimeError(
              "resource.conflict",
              "Concurrent completion has different metadata.",
            );
          return current.slot;
        }
        const result = await options.dispatch(
          {
            resourceType: "contentItem",
            resourceId: contentId,
            commandName: "completeUpload",
            input: { expectedVersion: current.previous.version, assetId, object },
            idempotencyKey: `upload:${assetId}:${current.previous.version}`,
            requestContext: {},
          },
          {
            subject: uploadVerifierIdentity.subject,
            roles: [uploadVerifierIdentity.role],
            claims: {},
            mode: "dev",
          },
        );
        if (result.ok) {
          const completed = await load();
          if (!sameReady(completed.slot, object))
            throw new JawStackRuntimeError(
              "resource.conflict",
              "Upload completion is no longer current.",
            );
          return assetSlotSchema.parse(completed.slot);
        }
        if (result.error.code !== "resource.conflict")
          throw new JawStackRuntimeError(result.error.code, result.error.message);
      }
      throw new JawStackRuntimeError(
        "resource.conflict",
        "Upload completion exceeded its retry budget.",
      );
    } catch (error) {
      if (error instanceof JawStackRuntimeError) throw error;
      throw new JawStackRuntimeError(
        "runtime.unavailable",
        "Upload interrupted; retry the same bytes.",
      );
    } finally {
      active--;
    }
  };
}
