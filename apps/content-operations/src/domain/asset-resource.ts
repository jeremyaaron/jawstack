import { isDeepStrictEqual } from "node:util";
import {
  defineCommand,
  defineResource,
  JawStackRuntimeError,
  type CommandContext,
  type CommandDecision,
} from "@jawstack/core";
import {
  applyAssetSnapshotInput,
  assetSlotSchema,
  createAssetSnapshotInput,
  type AssetSlot,
} from "../shared/assets";
import { instantSchema, versionSchema } from "../shared/validation";
import { assetUi } from "../shared/presentation";
import { assetProjectionPlan } from "./projections";

export const assetProjectorIdentity = Object.freeze({
  subject: "asset_projector",
  role: "assetProjector",
});
export function createAssetResource() {
  const decide = (
    context: CommandContext,
    snapshot: AssetSlot,
    expectedVersion?: number,
  ): CommandDecision => {
    if (
      context.auth.subject !== assetProjectorIdentity.subject ||
      !context.auth.roles.includes(assetProjectorIdentity.role) ||
      !["dev", "test"].includes(context.auth.mode)
    )
      throw new JawStackRuntimeError(
        "auth.forbidden",
        "Only the internal asset projector can materialize assets.",
      );
    if (context.resourceId !== snapshot.assetId)
      throw new JawStackRuntimeError("command.validation", "Asset target differs from snapshot.");
    let previous: AssetSlot | undefined;
    if (context.previous) {
      const parsed = assetSlotSchema.safeParse(context.previous.state);
      if (
        !parsed.success ||
        parsed.data.assetId !== context.resourceId ||
        context.previous.resourceType !== "asset" ||
        context.previous.resourceId !== context.resourceId ||
        !versionSchema.safeParse(context.previous.version).success ||
        !instantSchema.safeParse(context.previous.createdAt).success ||
        !instantSchema.safeParse(context.previous.updatedAt).success
      )
        throw new JawStackRuntimeError("resource.invalid_state", "Stored asset is invalid.");
      previous = parsed.data;
      if (context.previous.version !== expectedVersion)
        throw new JawStackRuntimeError(
          "resource.conflict",
          "Asset changed before materialization.",
        );
      const immutable = (asset: AssetSlot) => ({
        assetId: asset.assetId,
        contentId: asset.contentId,
        filename: asset.filename,
        mediaType: asset.mediaType,
        expectedSize: asset.expectedSize,
        objectKey: asset.objectKey,
        uploaderId: asset.uploaderId,
        registeredAt: asset.registeredAt,
        uploadExpiresAt: asset.uploadExpiresAt,
      });
      if (
        snapshot.sourceVersion <= previous.sourceVersion ||
        !isDeepStrictEqual(immutable(previous), immutable(snapshot)) ||
        (previous.verified && !isDeepStrictEqual(previous.verified, snapshot.verified)) ||
        (previous.status !== "pending" && snapshot.status === "pending") ||
        (previous.status === "ready" && snapshot.status === "expired") ||
        (previous.retiredAt &&
          (snapshot.status !== previous.status ||
            snapshot.retiredAt !== previous.retiredAt ||
            !isDeepStrictEqual(previous.verified, snapshot.verified)))
      )
        throw new JawStackRuntimeError(
          "command.rejected",
          "Asset snapshot is stale or rewrites immutable lifecycle metadata.",
        );
    }
    return {
      nextState: snapshot,
      activity: [
        { activityType: "snapshotApplied", title: "Applied authoritative attachment fact" },
      ],
      events: [{ eventType: "asset.snapshotApplied", schemaVersion: 1, payload: snapshot }],
      projections: assetProjectionPlan(previous, snapshot),
      response: { resourceId: snapshot.assetId, sourceVersion: snapshot.sourceVersion },
    };
  };
  return defineResource({
    name: assetUi.name,
    title: assetUi.title,
    state: assetUi.state,
    views: assetUi.views,
    commands: {
      createSnapshot: defineCommand({
        title: "Create asset snapshot",
        roles: [assetProjectorIdentity.role],
        create: true,
        input: createAssetSnapshotInput,
        emits: [{ eventType: "asset.snapshotApplied", schemaVersion: 1 }],
        decide: (context) => decide(context, context.input.snapshot),
      }),
      applySnapshot: defineCommand({
        title: "Apply asset snapshot",
        roles: [assetProjectorIdentity.role],
        input: applyAssetSnapshotInput,
        emits: [{ eventType: "asset.snapshotApplied", schemaVersion: 1 }],
        decide: (context) => decide(context, context.input.snapshot, context.input.expectedVersion),
      }),
    },
  });
}
