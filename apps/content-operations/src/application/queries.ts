import { createHash } from "node:crypto";
import { z } from "zod";
import {
  JawStackRuntimeError,
  type ResourceRepository,
  type QueryRepository,
  type ProjectionQuery,
  type ProjectionRecord,
  type Page,
  type AuthContext,
} from "@jawstack/core";
import {
  contentQueryInput,
  reviewQueryInput,
  calendarQueryInput,
  operationsQueryInput,
  pageInput,
  publicValue,
} from "../shared/api";
import {
  contentStateSchema,
  reviewTaskStateSchema,
  contentStatuses,
  reviewStatuses,
} from "../shared/contracts";
import { assetSlotSchema } from "../shared/assets";
import { fixtureIdentities, fixtureIds, editorIds } from "../shared/identities";
import { idSchema, instantSchema, versionSchema } from "../shared/validation";
import { eventIdentitySchema } from "../shared/events";
import { notificationSchema } from "./notifications";
import { publicationOperationSchema } from "./publication-operations";
import { failureSummarySchema } from "./failure-records";
import { activityViewSchema } from "../shared/review-views";

const contentData = z.object({
  title: z.string().max(160),
  status: z.enum(contentStatuses),
  authorId: z.enum(fixtureIds),
  revisionId: idSchema,
  version: versionSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
const calendarData = contentData.extend({
  scheduledAt: instantSchema,
  generation: idSchema,
  timeZone: z.string().max(100),
});
const reviewData = z.object({
  contentId: idSchema,
  title: z.string().max(160),
  status: z.enum(reviewStatuses),
  assignedEditorId: z.enum(editorIds),
  dueAt: instantSchema,
  sourceVersion: versionSchema,
});

export function requireFixture(auth: AuthContext, editor = false) {
  const identity = fixtureIdentities.find((actor) => actor.subject === auth.subject);
  if (
    !identity ||
    !["dev", "test"].includes(auth.mode) ||
    !identity.roles.some((role) => auth.roles.includes(role)) ||
    (editor && !(identity.roles.includes("editor") && auth.roles.includes("editor")))
  )
    throw new JawStackRuntimeError(
      "auth.forbidden",
      "This operation requires a resolved local fixture identity.",
    );
}
const cursorSchema = z.strictObject({
  version: z.literal(1),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  inner: z.string().min(1).max(4096),
  cutoff: instantSchema.optional(),
});
export function createContentQueries(options: {
  repository: ResourceRepository & QueryRepository;
  clock?: () => Date;
}) {
  const clock = options.clock ?? (() => new Date());
  const load = async (type: "contentItem" | "reviewTask" | "asset", id: string) => {
    idSchema.parse(id);
    const row = await options.repository.getState(type, id);
    if (!row) throw new JawStackRuntimeError("resource.not_found", "Resource was not found.");
    const schema =
      type === "contentItem"
        ? contentStateSchema
        : type === "reviewTask"
          ? reviewTaskStateSchema
          : assetSlotSchema;
    const parsed = schema.safeParse(row.state);
    if (
      !parsed.success ||
      row.resourceType !== type ||
      row.resourceId !== id ||
      !versionSchema.safeParse(row.version).success ||
      !instantSchema.safeParse(row.createdAt).success ||
      !instantSchema.safeParse(row.updatedAt).success ||
      !eventIdentitySchema.safeParse(row.createdBy).success ||
      !eventIdentitySchema.safeParse(row.updatedBy).success ||
      ("assetId" in parsed.data
        ? parsed.data.assetId
        : "reviewId" in parsed.data
          ? parsed.data.reviewId
          : parsed.data.contentId) !== id
    )
      throw new JawStackRuntimeError("resource.invalid_state", "Stored resource cannot be served.");
    return {
      resourceType: type,
      resourceId: id,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: eventIdentitySchema.parse(row.createdBy),
      updatedBy: eventIdentitySchema.parse(row.updatedBy),
      state: parsed.data,
    };
  };
  const filtered = async (
    auth: AuthContext,
    kind: string,
    query: { limit: number; cursor?: string | undefined },
    filters: unknown,
    projection: ProjectionQuery,
    matches: (row: ProjectionRecord, cutoff?: string) => boolean,
    schema: z.ZodType,
    timed = false,
  ): Promise<Page<ProjectionRecord>> => {
    requireFixture(auth);
    const scopeFor = (cutoff?: string) =>
      createHash("sha256")
        .update(JSON.stringify([kind, auth.subject, filters, projection, cutoff ?? null]))
        .digest("hex");
    let inner: string | undefined;
    let cutoff = timed ? clock().toISOString() : undefined;
    if (query.cursor) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error();
        const bytes = Buffer.from(query.cursor, "base64url");
        if (bytes.toString("base64url") !== query.cursor) throw new Error();
        const parsed = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
        if (parsed.scope !== scopeFor(parsed.cutoff) || (parsed.cutoff !== undefined) !== timed)
          throw new Error();
        inner = parsed.inner;
        cutoff = parsed.cutoff;
      } catch {
        throw new JawStackRuntimeError("query.invalid", "Invalid query continuation.");
      }
    }
    const items: ProjectionRecord[] = [];
    let evaluated = 0;
    do {
      const limit = Math.min(query.limit - items.length, 200 - evaluated);
      const page = await options.repository.queryProjection({
        ...projection,
        limit,
        ...(inner ? { cursor: inner } : {}),
      });
      if (page.items.length > limit || (page.nextCursor === inner && inner !== undefined))
        throw new JawStackRuntimeError(
          "runtime.internal",
          "Query dependency violated its paging budget.",
        );
      // A filtered/short service page may have evaluated the entire requested limit.
      evaluated += limit;
      for (const row of page.items) {
        const parsed = schema.safeParse(row.data);
        if (!parsed.success)
          throw new JawStackRuntimeError(
            "resource.invalid_state",
            "Stored query row cannot be served.",
          );
        const safe = {
          projectionName: projection.projectionName,
          itemId: row.itemId,
          sort: row.sort,
          data: publicValue(parsed.data) as Record<string, unknown>,
        };
        if (matches(safe, cutoff)) items.push(safe);
      }
      inner = page.nextCursor;
    } while (inner && evaluated < 200 && items.length < query.limit);
    if (!inner) return { items };
    const cursor = Buffer.from(
      JSON.stringify({ version: 1, scope: scopeFor(cutoff), inner, ...(cutoff ? { cutoff } : {}) }),
    ).toString("base64url");
    if (cursor.length > 4096)
      throw new JawStackRuntimeError("runtime.internal", "Query continuation exceeded its budget.");
    return { items, nextCursor: cursor };
  };
  return {
    load,
    content: async (auth: AuthContext, input: unknown) => {
      const q = contentQueryInput.parse(input);
      return filtered(
        auth,
        "content",
        q,
        { status: q.status ?? null, authorId: q.authorId ?? null, title: q.title ?? "" },
        { projectionName: q.status ? `contentItem.status.${q.status}` : "contentItem.list" },
        (row) =>
          (!q.authorId || row.data.authorId === q.authorId) &&
          (!q.title ||
            String(row.data.title ?? "")
              .normalize("NFC")
              .toLowerCase()
              .includes(q.title)),
        contentData,
      );
    },
    reviews: async (auth: AuthContext, input: unknown) => {
      const q = reviewQueryInput.parse(input);
      return filtered(
        auth,
        "reviews",
        q,
        {
          contentId: q.contentId ?? null,
          editorId: q.editorId ?? null,
          status: q.status ?? null,
          overdue: q.overdue,
        },
        {
          projectionName: q.editorId
            ? `reviewTask.editor.${q.editorId}`
            : q.status === "pending" || q.overdue === "true"
              ? "reviewTask.pending"
              : "reviewTask.list",
        },
        (row, cutoff) =>
          (!q.contentId || row.data.contentId === q.contentId) &&
          (!q.status || row.data.status === q.status) &&
          (q.overdue === "false" ||
            (row.data.status === "pending" && String(row.data.dueAt) <= cutoff!)),
        reviewData,
        q.overdue === "true",
      );
    },
    calendar: async (auth: AuthContext, input: unknown) => {
      const q = calendarQueryInput.parse(input);
      return filtered(
        auth,
        "calendar",
        q,
        { from: q.from, before: q.before },
        { projectionName: "contentItem.calendar", sortFrom: q.from, sortBefore: q.before },
        () => true,
        calendarData,
      );
    },
    operations: async (auth: AuthContext, input: unknown) => {
      requireFixture(auth, true);
      const q = operationsQueryInput.parse(input);
      const projectionName =
        q.view === "attempts"
          ? q.contentId
            ? `contentItem.publicationAttempts.${q.contentId}`
            : "contentItem.publicationAttempts"
          : q.view === "notifications"
            ? q.recipientId
              ? `contentItem.notifications.${q.recipientId}`
              : "contentItem.notifications"
            : "contentItem.failures";
      return filtered(
        auth,
        "operations",
        q,
        {
          view: q.view,
          contentId: q.contentId ?? null,
          recipientId: q.recipientId ?? null,
          status: q.status ?? null,
        },
        { projectionName },
        (row) =>
          (!q.contentId ||
            (q.view === "failures" ? row.data.resourceId : row.data.contentId) === q.contentId) &&
          (!q.status ||
            (q.view === "attempts"
              ? (row.data.attempt as { status?: string } | undefined)?.status
              : row.data.status) === q.status),
        q.view === "attempts"
          ? publicationOperationSchema
          : q.view === "notifications"
            ? notificationSchema
            : failureSummarySchema,
      );
    },
    resource: async (
      auth: AuthContext,
      type: "contentItem" | "reviewTask" | "asset",
      id: string,
    ) => {
      requireFixture(auth);
      return { resource: publicValue(await load(type, id)) };
    },
    activity: async (
      auth: AuthContext,
      type: "contentItem" | "reviewTask" | "asset",
      id: string,
      input: unknown,
    ) => {
      requireFixture(auth);
      await load(type, id);
      const q = pageInput.parse(input);
      const page = await options.repository.queryActivity({
        resourceType: type,
        resourceId: id,
        limit: q.limit,
        ...(q.cursor ? { cursor: q.cursor } : {}),
      });
      return {
        ...page,
        items: page.items.map((row) => {
          const parsed = activityViewSchema.safeParse(row);
          if (!parsed.success || parsed.data.resourceId !== id || parsed.data.resourceType !== type)
            throw new JawStackRuntimeError(
              "resource.invalid_state",
              "Stored activity cannot be served.",
            );
          return publicValue(parsed.data);
        }),
      };
    },
  };
}
