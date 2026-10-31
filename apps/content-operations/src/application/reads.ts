import { JawStackRuntimeError } from "@jawstack/core";
import type { AuthContext } from "@jawstack/core";
import { assetSlotSchema } from "../shared/assets";
import { contentStateSchema, publicationObjectKey } from "../shared/contracts";
import { idSchema } from "../shared/validation";
import { publicValue } from "../shared/api";
import { verifyPublicationBytes } from "./publication-artifact";
import { createContentQueries, requireFixture } from "./queries";
import type { ApiRuntime } from "./api-runtime";

export function createPrivateReads(runtime: ApiRuntime) {
  const queries = createContentQueries({ repository: runtime.repository, clock: runtime.clock });
  const content = async (id: string) =>
    contentStateSchema.parse((await queries.load("contentItem", id)).state);
  return {
    download: async (auth: AuthContext, assetId: string, contentId?: string) => {
      requireFixture(auth);
      idSchema.parse(assetId);
      let parentId = contentId;
      if (!parentId)
        parentId = assetSlotSchema.parse((await queries.load("asset", assetId)).state).contentId;
      let state = await content(idSchema.parse(parentId));
      const reference = (current: typeof state) => {
        const slot = current.attachments.find((asset) => asset.assetId === assetId);
        if (!slot?.verified || !["ready", "removed"].includes(slot.status))
          throw new JawStackRuntimeError(
            "resource.not_found",
            "A verified attachment is not available.",
          );
        return {
          contentId: current.contentId,
          assetId,
          objectKey: slot.objectKey,
          filename: slot.filename,
          mediaType: slot.mediaType,
          size: slot.verified.size,
          sha256: slot.verified.sha256,
        };
      };
      const ref = reference(state);
      const { filename, ...object } = ref;
      const bytes = await runtime.objects.read(object);
      state = await content(parentId);
      const latest = reference(state);
      if (
        latest.sha256 !== ref.sha256 ||
        latest.size !== ref.size ||
        latest.objectKey !== ref.objectKey
      )
        throw new JawStackRuntimeError(
          "resource.conflict",
          "Attachment authority changed during readback.",
        );
      return { bytes, filename, mediaType: ref.mediaType, sha256: ref.sha256 };
    },
    publication: async (auth: AuthContext, id: string) => {
      requireFixture(auth);
      const state = await content(id);
      const publication = state.publication;
      if (
        !publication ||
        publication.phase !== "succeeded" ||
        !publication.artifact ||
        !["published", "archived"].includes(state.status)
      )
        throw new JawStackRuntimeError(
          "resource.not_found",
          "No committed publication is available.",
        );
      const bytes = await runtime.objects.readPublication(publication.intent);
      const verified = verifyPublicationBytes(publication.intent, bytes);
      if (
        publication.artifact.objectKey !==
          publicationObjectKey(id, publication.intent.publicationId) ||
        verified.sha256 !== publication.artifact.sha256 ||
        verified.size !== publication.artifact.size
      )
        throw new JawStackRuntimeError(
          "resource.invalid_state",
          "Committed publication metadata differs from its artifact.",
        );
      const latest = await content(id);
      if (
        latest.publication?.phase !== "succeeded" ||
        latest.publication.artifact?.sha256 !== verified.sha256
      )
        throw new JawStackRuntimeError(
          "resource.conflict",
          "Publication authority changed during readback.",
        );
      return {
        artifact: publicValue(
          JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>,
        ),
        sha256: verified.sha256,
        size: verified.size,
        completedAt: publication.artifact.completedAt,
      };
    },
  };
}
