import { isDeepStrictEqual } from "node:util";
import {
  defineCommand,
  defineResource,
  JawStackRuntimeError,
  type AuthContext,
  type CommandContext,
  type CommandDecision,
  type EventDraft,
  type ResourceState,
} from "@jawstack/core";
import {
  applyReviewSnapshotInput,
  contentEventSchemas,
  contentStateSchema,
  createReviewSnapshotInput,
  idSchema,
  instantSchema,
  reviewTaskStateSchema,
  versionSchema,
  type ContentEventType,
  type ContentState,
  type ReviewTaskState,
} from "../shared/contracts";
import { fixtureIdentities } from "../shared/identities";
import { contentUi, reviewUi } from "../shared/presentation";
import { contentProjectionPlan, reviewProjectionPlan } from "./projections";
import {
  activeAsset,
  assetObjectKey,
  assetVersionInput,
  completeUploadInput,
  readyAttachments,
  type AssetSlot,
} from "../shared/assets";
import { limits } from "../shared/validation";
import { createAssetResource } from "./asset-resource";
import { contentWorkers } from "./subscriptions";

type ResourceOptions = Readonly<{ newId?: () => string }>;
type ContentResponse = Readonly<{
  resourceId: string;
  version: number;
  revisionId: string;
  status: ContentState["status"];
  reviewId?: string;
  assetId?: string;
}>;
const fail = (
  code: ConstructorParameters<typeof JawStackRuntimeError>[0],
  message: string,
  details?: unknown,
): never => {
  throw new JawStackRuntimeError(code, message, details);
};
const requireThat = (condition: unknown, message: string) => {
  if (!condition) fail("command.rejected", message);
};
export const uploadVerifierIdentity = Object.freeze({
  subject: "upload_verifier",
  role: "uploadVerifier",
});
export const assetJanitorIdentity = Object.freeze({
  subject: "asset_janitor",
  role: "assetJanitor",
});
function serviceActor(auth: AuthContext, identity: { subject: string; role: string }) {
  if (
    auth.subject !== identity.subject ||
    !auth.roles.includes(identity.role) ||
    !["dev", "test"].includes(auth.mode)
  )
    fail("auth.forbidden", "A resolved internal service identity is required.");
}

function actor(auth: AuthContext) {
  const fixture = fixtureIdentities.find((identity) => identity.subject === auth.subject);
  if (
    !fixture ||
    !["test", "dev"].includes(auth.mode) ||
    !fixture.roles.some((role) => auth.roles.includes(role))
  )
    return fail("auth.forbidden", "A resolved local author/editor identity is required.");
  return {
    subject: fixture.subject,
    editor: fixture.roles.includes("editor") && auth.roles.includes("editor"),
  };
}

function storedContent(
  context: CommandContext,
  expectedVersion: number,
  policy: "ownerOrEditor" | "editor" | "uploadVerifier" | "assetJanitor",
): ResourceState<ContentState> {
  const identity =
    policy === "uploadVerifier" || policy === "assetJanitor"
      ? (serviceActor(
          context.auth,
          policy === "uploadVerifier" ? uploadVerifierIdentity : assetJanitorIdentity,
        ),
        undefined)
      : actor(context.auth);
  const previous = context.previous;
  const parsed = contentStateSchema.safeParse(previous?.state);
  if (
    !previous ||
    !parsed.success ||
    previous.resourceType !== "contentItem" ||
    previous.resourceId !== context.resourceId ||
    parsed.data.contentId !== context.resourceId ||
    !versionSchema.safeParse(previous.version).success ||
    (parsed.data.review && parsed.data.review.sourceVersion > previous.version) ||
    parsed.data.attachments.some((asset) => asset.sourceVersion > previous.version) ||
    !instantSchema.safeParse(previous.createdAt).success ||
    !instantSchema.safeParse(previous.updatedAt).success
  )
    return fail("resource.invalid_state", "Stored content is invalid.");
  if (
    identity &&
    !identity.editor &&
    (policy === "editor" || identity.subject !== parsed.data.authorId)
  )
    return fail("auth.forbidden", "This identity cannot change this content.");
  if (previous.version !== expectedVersion)
    return fail("resource.conflict", "Content changed; reload before retrying.", {
      expectedVersion,
      actualVersion: previous.version,
    });
  return { ...previous, state: parsed.data };
}

function fact(type: ContentEventType, payload: unknown): EventDraft {
  const parsed = contentEventSchemas[type].safeParse(payload);
  if (!parsed.success)
    return fail("command.validation", "Domain event failed validation.", parsed.error.issues);
  return { eventType: type, schemaVersion: 1, payload: parsed.data };
}

function finish(
  context: CommandContext,
  previous: ResourceState<ContentState> | undefined,
  candidate: ContentState,
  eventType: ContentEventType,
  title: string,
  reviews: readonly EventDraft[] = [],
  asset?: AssetSlot,
): CommandDecision<ContentState, ContentResponse> {
  const parsed = contentStateSchema.safeParse(candidate);
  if (!parsed.success)
    return fail(
      "command.validation",
      "Resulting content failed validation or size bounds.",
      parsed.error.issues,
    );
  const next = parsed.data;
  const version = (previous?.version ?? 0) + 1;
  if (!versionSchema.safeParse(version).success)
    return fail("resource.invalid_state", "Content version is exhausted.");
  const payload =
    asset ??
    (["contentItem.reviewRequested", "contentItem.reviewDecided"].includes(eventType)
      ? next.review
      : {
          contentId: next.contentId,
          authorId: next.authorId,
          title: next.title,
          revisionId: next.revisionId,
          status: next.status,
          sourceVersion: version,
        });
  return {
    nextState: next,
    activity: [
      {
        activityType: eventType.split(".")[1]!,
        title,
        data: {
          revisionId: next.revisionId,
          ...(next.review ? { reviewId: next.review.reviewId } : {}),
        },
      },
    ],
    events: [...reviews, fact(eventType, payload)],
    projections: contentProjectionPlan(previous, next, context.now.toISOString()),
    response: {
      resourceId: next.contentId,
      version,
      revisionId: next.revisionId,
      status: next.status,
      ...(next.review ? { reviewId: next.review.reviewId } : {}),
      ...(asset ? { assetId: asset.assetId } : {}),
    },
  };
}

function supersede(context: CommandContext, previous: ResourceState<ContentState>) {
  if (previous.state.review?.status !== "pending")
    return { review: previous.state.review, facts: [] };
  const review = reviewTaskStateSchema.parse({
    ...previous.state.review,
    status: "superseded",
    sourceVersion: previous.version + 1,
    decision: { actorId: actor(context.auth).subject, at: context.now.toISOString(), note: null },
  });
  return { review, facts: [fact("contentItem.reviewSuperseded", review)] };
}

export function createContentItemResource(options: ResourceOptions = {}) {
  const newId = (context: CommandContext, previous?: ContentState) => {
    const value = (options.newId ?? (() => globalThis.crypto.randomUUID()))();
    if (
      !idSchema.safeParse(value).success ||
      [context.resourceId, previous?.revisionId, previous?.review?.reviewId].includes(value) ||
      previous?.attachments.some((slot) => slot.assetId === value)
    )
      return fail("runtime.internal", "ID generator did not produce a fresh UUID.");
    return value;
  };
  return defineResource({
    name: contentUi.name,
    workers: contentWorkers,
    title: contentUi.title,
    state: contentUi.state,
    views: contentUi.views,
    commands: {
      create: defineCommand({
        ...contentUi.commands.create,
        emits: [{ eventType: "contentItem.created", schemaVersion: 1 }],
        decide: (context) => {
          const identity = actor(context.auth);
          if (!idSchema.safeParse(context.resourceId).success)
            return fail("command.validation", "Content IDs must be generated UUIDs.");
          return finish(
            context,
            undefined,
            {
              contentId: context.resourceId,
              authorId: identity.subject,
              title: context.input.title,
              body: context.input.body,
              revisionId: newId(context),
              status: "draft",
              attachments: [],
              review: null,
              approval: null,
              schedule: null,
            },
            "contentItem.created",
            "Created draft",
          );
        },
      }),
      editDraft: defineCommand({
        ...contentUi.commands.editDraft,
        emits: [{ eventType: "contentItem.draftEdited", schemaVersion: 1 }],
        decide: (context) => {
          const previous = storedContent(context, context.input.expectedVersion, "ownerOrEditor");
          requireThat(previous.state.status === "draft", "Only a draft can be edited.");
          const changed =
            previous.state.title !== context.input.title ||
            previous.state.body !== context.input.body;
          return finish(
            context,
            previous,
            {
              ...previous.state,
              title: context.input.title,
              body: context.input.body,
              revisionId: changed ? newId(context, previous.state) : previous.state.revisionId,
            },
            "contentItem.draftEdited",
            "Saved draft",
          );
        },
      }),
      submit: defineCommand({
        ...contentUi.commands.submit,
        emits: [{ eventType: "contentItem.reviewRequested", schemaVersion: 1 }],
        decide: (context) => {
          const previous = storedContent(context, context.input.expectedVersion, "ownerOrEditor");
          requireThat(previous.state.status === "draft", "Only a draft can be submitted.");
          requireThat(
            !previous.state.attachments.some((asset) => asset.status === "pending"),
            "Every active attachment must be ready before submission.",
          );
          if (Date.parse(context.input.dueAt) <= context.now.getTime())
            return fail("command.validation", "Review due time must be in the future.");
          const review = reviewTaskStateSchema.safeParse({
            reviewId: newId(context, previous.state),
            contentId: context.resourceId,
            assignedEditorId: context.input.assignedEditorId,
            dueAt: context.input.dueAt,
            status: "pending",
            sourceVersion: previous.version + 1,
            decision: null,
            submitted: {
              contentId: context.resourceId,
              authorId: previous.state.authorId,
              title: previous.state.title,
              body: previous.state.body,
              revisionId: previous.state.revisionId,
              attachments: readyAttachments(previous.state.attachments),
              submittedAt: context.now.toISOString(),
            },
          });
          if (!review.success)
            return fail(
              "command.validation",
              "Review snapshot failed validation or size bounds.",
              review.error.issues,
            );
          return finish(
            context,
            previous,
            { ...previous.state, status: "inReview", review: review.data },
            "contentItem.reviewRequested",
            "Submitted for review",
          );
        },
      }),
      registerAsset: defineCommand({
        ...contentUi.commands.registerAsset,
        emits: [{ eventType: "contentItem.assetRegistered", schemaVersion: 1 }],
        decide: (context) => {
          const previous = storedContent(context, context.input.expectedVersion, "ownerOrEditor");
          requireThat(
            previous.state.status === "draft",
            "Attachments can only be registered on drafts.",
          );
          requireThat(
            previous.state.attachments.filter(activeAsset).length < limits.activeAssets &&
              previous.state.attachments.length < limits.retainedAssets,
            "Attachment slot capacity reached.",
          );
          const assetId = newId(context, previous.state);
          const revisionId = newId(context, previous.state);
          if (assetId === revisionId)
            return fail("runtime.internal", "Asset and revision IDs must differ.");
          const asset: AssetSlot = {
            assetId,
            contentId: context.resourceId,
            filename: context.input.filename,
            mediaType: context.input.mediaType,
            expectedSize: context.input.expectedSize,
            objectKey: assetObjectKey(context.resourceId, assetId),
            uploaderId: actor(context.auth).subject,
            status: "pending",
            registeredAt: context.now.toISOString(),
            uploadExpiresAt: new Date(
              context.now.getTime() + limits.uploadLifetimeMs,
            ).toISOString(),
            verified: null,
            retiredAt: null,
            sourceVersion: previous.version + 1,
          };
          return finish(
            context,
            previous,
            { ...previous.state, revisionId, attachments: [...previous.state.attachments, asset] },
            "contentItem.assetRegistered",
            "Registered attachment",
            [],
            asset,
          );
        },
      }),
      completeUpload: defineCommand({
        title: "Verify upload",
        roles: [uploadVerifierIdentity.role],
        input: completeUploadInput,
        emits: [{ eventType: "contentItem.assetReady", schemaVersion: 1 }],
        decide: (context) => {
          const previous = storedContent(context, context.input.expectedVersion, "uploadVerifier");
          const slot = previous.state.attachments.find(
            (asset) => asset.assetId === context.input.assetId,
          );
          requireThat(
            previous.state.status === "draft" && slot?.status === "pending",
            "Upload requires a pending slot on a draft.",
          );
          requireThat(
            context.now.getTime() < Date.parse(slot!.uploadExpiresAt),
            "Upload slot has expired.",
          );
          const object = context.input.object;
          requireThat(
            object.contentId === context.resourceId &&
              object.assetId === slot!.assetId &&
              object.objectKey === slot!.objectKey &&
              object.mediaType === slot!.mediaType &&
              object.size === slot!.expectedSize,
            "Verified object differs from the registered slot.",
          );
          const asset: AssetSlot = {
            ...slot!,
            status: "ready",
            verified: { size: object.size, sha256: object.sha256, at: context.now.toISOString() },
            sourceVersion: previous.version + 1,
          };
          return finish(
            context,
            previous,
            {
              ...previous.state,
              attachments: previous.state.attachments.map((old) =>
                old.assetId === asset.assetId ? asset : old,
              ),
            },
            "contentItem.assetReady",
            "Verified attachment",
            [],
            asset,
          );
        },
      }),
      ...Object.fromEntries(
        (["removeAsset", "expireAsset"] as const).map((name) => [
          name,
          defineCommand({
            ...(name === "removeAsset"
              ? contentUi.commands.removeAsset
              : {
                  title: "Expire upload",
                  roles: [assetJanitorIdentity.role],
                  input: assetVersionInput,
                }),
            emits: [
              {
                eventType:
                  name === "removeAsset" ? "contentItem.assetRemoved" : "contentItem.assetExpired",
                schemaVersion: 1,
              },
            ],
            decide: (context) => {
              const previous = storedContent(
                context,
                context.input.expectedVersion,
                name === "removeAsset" ? "ownerOrEditor" : "assetJanitor",
              );
              const slot = previous.state.attachments.find(
                (asset) => asset.assetId === context.input.assetId,
              );
              requireThat(
                previous.state.status === "draft" && slot && activeAsset(slot),
                "Only active draft attachments can be retired.",
              );
              if (name === "expireAsset")
                requireThat(
                  slot!.status === "pending" &&
                    context.now.getTime() >= Date.parse(slot!.uploadExpiresAt),
                  "Only expired pending uploads can be expired.",
                );
              const asset: AssetSlot = {
                ...slot!,
                status: name === "removeAsset" ? "removed" : "expired",
                retiredAt: context.now.toISOString(),
                sourceVersion: previous.version + 1,
              };
              return finish(
                context,
                previous,
                {
                  ...previous.state,
                  revisionId: newId(context, previous.state),
                  attachments: previous.state.attachments.map((old) =>
                    old.assetId === asset.assetId ? asset : old,
                  ),
                },
                name === "removeAsset" ? "contentItem.assetRemoved" : "contentItem.assetExpired",
                name === "removeAsset" ? "Removed attachment" : "Expired upload",
                [],
                asset,
              );
            },
          }),
        ]),
      ),
      ...Object.fromEntries(
        (["approve", "requestChanges"] as const).map((name) => [
          name,
          defineCommand({
            ...contentUi.commands[name],
            emits: [{ eventType: "contentItem.reviewDecided", schemaVersion: 1 }],
            decide: (context) => {
              const previous = storedContent(context, context.input.expectedVersion, "editor");
              requireThat(
                previous.state.status === "inReview" && previous.state.review?.status === "pending",
                "Content has no pending review.",
              );
              const current = previous.state.review!;
              if (
                current.reviewId !== context.input.reviewId ||
                previous.state.revisionId !== context.input.revisionId
              )
                return fail("resource.conflict", "Review or revision is no longer current.");
              const identity = actor(context.auth);
              const at = context.now.toISOString();
              const review = {
                ...current,
                status: name === "approve" ? ("approved" as const) : ("changesRequested" as const),
                sourceVersion: previous.version + 1,
                decision: { actorId: identity.subject, at, note: context.input.note },
              };
              const approval =
                name === "approve"
                  ? {
                      reviewId: current.reviewId,
                      revisionId: previous.state.revisionId,
                      approvedBy: identity.subject as "editor_1" | "editor_2",
                      approvedAt: at,
                    }
                  : null;
              return finish(
                context,
                previous,
                {
                  ...previous.state,
                  status: name === "approve" ? "approved" : "draft",
                  review,
                  approval,
                },
                "contentItem.reviewDecided",
                name === "approve" ? "Approved content" : "Requested changes",
              );
            },
          }),
        ]),
      ),
      reopenDraft: defineCommand({
        ...contentUi.commands.reopenDraft,
        emits: [
          { eventType: "contentItem.draftReopened", schemaVersion: 1 },
          { eventType: "contentItem.reviewSuperseded", schemaVersion: 1 },
        ],
        decide: (context) => {
          const previous = storedContent(context, context.input.expectedVersion, "ownerOrEditor");
          requireThat(
            ["inReview", "approved", "scheduled"].includes(previous.state.status),
            "This content cannot be reopened.",
          );
          const closed = supersede(context, previous);
          return finish(
            context,
            previous,
            {
              ...previous.state,
              status: "draft",
              revisionId: newId(context, previous.state),
              review: closed.review,
              approval: null,
              schedule: null,
            },
            "contentItem.draftReopened",
            "Reopened draft",
            closed.facts,
          );
        },
      }),
      archive: defineCommand({
        ...contentUi.commands.archive,
        emits: [
          { eventType: "contentItem.archived", schemaVersion: 1 },
          { eventType: "contentItem.reviewSuperseded", schemaVersion: 1 },
        ],
        decide: (context) => {
          const previous = storedContent(context, context.input.expectedVersion, "editor");
          requireThat(
            ["draft", "inReview", "approved", "scheduled", "published"].includes(
              previous.state.status,
            ),
            "Active publication or archived content cannot be archived.",
          );
          const closed = supersede(context, previous);
          return finish(
            context,
            previous,
            { ...previous.state, status: "archived", review: closed.review, schedule: null },
            "contentItem.archived",
            "Archived content",
            closed.facts,
          );
        },
      }),
    },
  });
}

export const reviewProjectorIdentity = Object.freeze({
  subject: "review_projector",
  role: "reviewProjector",
});

export function createReviewTaskResource() {
  const internal = (auth: AuthContext) => {
    if (
      auth.subject !== reviewProjectorIdentity.subject ||
      !auth.roles.includes(reviewProjectorIdentity.role) ||
      !["dev", "test"].includes(auth.mode)
    )
      fail("auth.forbidden", "Only the internal review projector can materialize reviews.");
  };
  const decide = (
    context: CommandContext,
    snapshot: ReviewTaskState,
    expectedVersion?: number,
  ): CommandDecision => {
    internal(context.auth);
    if (context.resourceId !== snapshot.reviewId)
      return fail("command.validation", "Review target ID differs from its snapshot.");
    let previous: ReviewTaskState | undefined;
    if (context.previous) {
      const parsed = reviewTaskStateSchema.safeParse(context.previous.state);
      if (
        !parsed.success ||
        parsed.data.reviewId !== context.resourceId ||
        context.previous.resourceType !== "reviewTask" ||
        context.previous.resourceId !== context.resourceId ||
        !versionSchema.safeParse(context.previous.version).success ||
        !instantSchema.safeParse(context.previous.createdAt).success ||
        !instantSchema.safeParse(context.previous.updatedAt).success
      )
        return fail("resource.invalid_state", "Stored review is invalid.");
      previous = parsed.data;
      if (context.previous.version !== expectedVersion)
        return fail("resource.conflict", "Review changed; reload before applying a snapshot.");
      requireThat(
        snapshot.sourceVersion > previous.sourceVersion,
        "Equal/older review snapshots must be ignored by the projector.",
      );
      requireThat(
        previous.contentId === snapshot.contentId &&
          previous.assignedEditorId === snapshot.assignedEditorId &&
          previous.dueAt === snapshot.dueAt &&
          isDeepStrictEqual(previous.submitted, snapshot.submitted),
        "A submitted review cannot be rewritten.",
      );
      requireThat(
        previous.status === "pending" ||
          (previous.status === snapshot.status &&
            isDeepStrictEqual(previous.decision, snapshot.decision)),
        "Closed review outcomes cannot be changed.",
      );
    }
    return {
      nextState: snapshot,
      activity: [
        { activityType: "snapshotApplied", title: "Applied authoritative content review fact" },
      ],
      events: [fact("reviewTask.snapshotApplied", snapshot)],
      projections: reviewProjectionPlan(previous, snapshot),
      response: { resourceId: snapshot.reviewId, sourceVersion: snapshot.sourceVersion },
    };
  };
  return defineResource({
    name: reviewUi.name,
    title: reviewUi.title,
    state: reviewUi.state,
    views: reviewUi.views,
    commands: {
      createSnapshot: defineCommand({
        title: "Create review snapshot",
        roles: [reviewProjectorIdentity.role],
        input: createReviewSnapshotInput,
        create: true,
        emits: [{ eventType: "reviewTask.snapshotApplied", schemaVersion: 1 }],
        decide: (context) => decide(context, context.input.snapshot),
      }),
      applySnapshot: defineCommand({
        title: "Apply review snapshot",
        roles: [reviewProjectorIdentity.role],
        input: applyReviewSnapshotInput,
        emits: [{ eventType: "reviewTask.snapshotApplied", schemaVersion: 1 }],
        decide: (context) => decide(context, context.input.snapshot, context.input.expectedVersion),
      }),
    },
  });
}

export function createContentOperationsResources(options: ResourceOptions = {}) {
  return [
    createContentItemResource(options),
    createReviewTaskResource(),
    createAssetResource(),
  ] as const;
}
