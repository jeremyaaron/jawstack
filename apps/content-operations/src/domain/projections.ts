import type { ProjectionWrite, ResourceState } from "@jawstack/core";
import type { ContentState, ReviewTaskState } from "../shared/contracts";
import type { AssetSlot } from "../shared/assets";

function contentRows(
  state: ContentState,
  createdAt: string,
  updatedAt: string,
  version: number,
): ProjectionWrite[] {
  if (state.status === "archived") return [];
  const data = {
    title: state.title,
    status: state.status,
    authorId: state.authorId,
    revisionId: state.revisionId,
    version,
    createdAt,
    updatedAt,
  };
  const row = (projectionName: string, sort: string, extra = {}): ProjectionWrite => ({
    projectionName,
    itemId: state.contentId,
    sort,
    data: { ...data, ...extra },
  });
  const rows = [
    row("contentItem.list", `${createdAt}#${state.contentId}`),
    row(`contentItem.status.${state.status}`, `${createdAt}#${state.contentId}`),
  ];
  if (state.status === "inReview" && state.review)
    rows.push(
      row("contentItem.dueReview", `${state.review.dueAt}#${state.contentId}`, {
        reviewId: state.review.reviewId,
        assignedEditorId: state.review.assignedEditorId,
        dueAt: state.review.dueAt,
      }),
    );
  if (state.schedule)
    for (const name of ["contentItem.calendar", "contentItem.duePublication"])
      rows.push(row(name, `${state.schedule.scheduledAt}#${state.contentId}`, state.schedule));
  for (const slot of state.attachments) {
    const data = { assetId: slot.assetId, contentId: state.contentId };
    if (state.status === "draft" && slot.status === "pending")
      rows.push(
        row(
          "contentItem.expiringUploads",
          `${slot.uploadExpiresAt}#${state.contentId}#${slot.assetId}`,
          data,
        ),
      );
    if (["removed", "expired"].includes(slot.status) && slot.verified === null)
      rows.push(
        row(
          "contentItem.orphanAssets",
          `${slot.retiredAt}#${state.contentId}#${slot.assetId}`,
          data,
        ),
      );
  }
  return rows;
}

function moves(
  previous: readonly ProjectionWrite[],
  next: readonly ProjectionWrite[],
): ProjectionWrite[] {
  const same = (a: ProjectionWrite, b: ProjectionWrite) =>
    a.projectionName === b.projectionName && a.itemId === b.itemId && a.sort === b.sort;
  return [
    ...previous
      .filter((old) => !next.some((row) => same(old, row)))
      .map((old) => ({ ...old, delete: true })),
    ...next,
  ];
}

export function contentProjectionPlan(
  previous: ResourceState<ContentState> | undefined,
  next: ContentState,
  now: string,
): ProjectionWrite[] {
  return moves(
    previous
      ? contentRows(previous.state, previous.createdAt, previous.updatedAt, previous.version)
      : [],
    contentRows(next, previous?.createdAt ?? now, now, (previous?.version ?? 0) + 1),
  );
}

function reviewRows(state: ReviewTaskState): ProjectionWrite[] {
  const data = {
    contentId: state.contentId,
    title: state.submitted.title,
    status: state.status,
    assignedEditorId: state.assignedEditorId,
    dueAt: state.dueAt,
    sourceVersion: state.sourceVersion,
  };
  const row = (projectionName: string): ProjectionWrite => ({
    projectionName,
    itemId: state.reviewId,
    sort: `${state.dueAt}#${state.reviewId}`,
    data,
  });
  return [
    row("reviewTask.list"),
    row(`reviewTask.editor.${state.assignedEditorId}`),
    ...(state.status === "pending" ? [row("reviewTask.pending")] : []),
  ];
}

export function reviewProjectionPlan(
  previous: ReviewTaskState | undefined,
  next: ReviewTaskState,
): ProjectionWrite[] {
  return moves(previous ? reviewRows(previous) : [], reviewRows(next));
}

export function assetProjectionPlan(
  previous: AssetSlot | undefined,
  next: AssetSlot,
): ProjectionWrite[] {
  const rows = (asset: AssetSlot): ProjectionWrite[] =>
    ["asset.list", `asset.content.${asset.contentId}`].map((projectionName) => ({
      projectionName,
      itemId: asset.assetId,
      sort: `${asset.registeredAt}#${asset.assetId}`,
      data: {
        filename: asset.filename,
        contentId: asset.contentId,
        mediaType: asset.mediaType,
        status: asset.status,
        sourceVersion: asset.sourceVersion,
        size: asset.verified?.size ?? asset.expectedSize,
        sha256: asset.verified?.sha256 ?? null,
      },
    }));
  return moves(previous ? rows(previous) : [], rows(next));
}
