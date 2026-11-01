import {
  JawStackApiError,
  type JawStackApiClient,
  type ExecuteCommandRequest,
  type ListOptions,
} from "@jawstack/angular";
import type { ResourceState, ProjectionRecord, ActivityRecord } from "@jawstack/core";
import { z } from "zod";
import {
  contentQueryInput,
  reviewQueryInput,
  calendarQueryInput,
  operationsQueryInput,
  pageInput,
  type ContentQuery,
  type ReviewQuery,
  type CalendarQuery,
  type OperationsQuery,
  type PublicValue,
} from "../shared/api";
import { contentStatuses, reviewStatuses, type ContentState } from "../shared/contracts";
import { fixtureIds, editorIds, type FixtureId } from "../shared/identities";
import { reviewViewSchema, activityViewSchema, type ReviewView } from "../shared/review-views";
import { idSchema, instantSchema, versionSchema, timeZoneSchema } from "../shared/validation";
import { contentUi } from "../shared/presentation";
import {
  publicationOperationSchema,
  notificationViewSchema,
  failureSummarySchema,
  type PublicationOperation,
  type NotificationView,
  type FailureSummary,
} from "../shared/operation-views";
import { assetViewSchema, publicationViewSchema, type AttachmentView } from "../shared/media-views";

export const contentSummarySchema = z.object({
  title: z.string(),
  status: z.enum(contentStatuses),
  authorId: z.enum(fixtureIds),
  revisionId: idSchema,
  version: versionSchema,
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type ContentRow = Omit<ProjectionRecord, "data"> & {
  data: z.infer<typeof contentSummarySchema>;
};
export type ContentResource = Omit<ResourceState, "state"> & { state: PublicValue<ContentState> };
export type ContentPage = { items: ContentRow[]; nextCursor?: string | undefined };
const calendarRowSchema = z.object({
  projectionName: z.literal("contentItem.calendar"),
  itemId: idSchema,
  sort: z.string(),
  data: contentSummarySchema.extend({
    status: z.literal("scheduled"),
    scheduledAt: instantSchema,
    generation: idSchema,
    timeZone: timeZoneSchema,
  }),
});
export type CalendarRow = z.infer<typeof calendarRowSchema>;
export type CalendarPage = { items: CalendarRow[]; nextCursor?: string | undefined };
export type OperationData = PublicationOperation | NotificationView | FailureSummary;
export type OperationRow = {
  projectionName: string;
  itemId: string;
  sort: string;
  data: OperationData;
};
export type OperationsPage = { items: OperationRow[]; nextCursor?: string | undefined };
export type CommandName = keyof typeof contentUi.commands;
export type CommandInput<N extends CommandName> = z.input<(typeof contentUi.commands)[N]["input"]>;
export type CommandResult = { resourceId: string; version: number; assetId?: string | undefined };
export type ReviewResource = Omit<ResourceState, "state"> & { state: ReviewView };
const reviewRowSchema = z.object({
  projectionName: z.string(),
  itemId: idSchema,
  sort: z.string(),
  data: z.object({
    contentId: idSchema,
    title: z.string().max(160),
    status: z.enum(reviewStatuses),
    assignedEditorId: z.enum(editorIds),
    dueAt: instantSchema,
    sourceVersion: versionSchema,
  }),
});
export type ReviewRow = z.infer<typeof reviewRowSchema>;
export type ReviewPage = { items: ReviewRow[]; nextCursor?: string | undefined };
export type ActivityPage = {
  items: z.infer<typeof activityViewSchema>[];
  nextCursor?: string | undefined;
};
const pageSchema = z.object({
  items: z.array(
    z.object({
      projectionName: z.string(),
      itemId: idSchema,
      sort: z.string(),
      data: contentSummarySchema,
    }),
  ),
  nextCursor: z.string().optional(),
});
const resourceSchema = z.object({
  resource: z.object({
    resourceType: z.literal("contentItem"),
    resourceId: idSchema,
    version: versionSchema,
    createdAt: instantSchema,
    updatedAt: instantSchema,
    createdBy: z.string(),
    updatedBy: z.string(),
    state: z
      .object({
        contentId: idSchema,
        title: z.string(),
        body: z.string(),
        status: z.enum(contentStatuses),
        authorId: z.enum(fixtureIds),
        revisionId: idSchema,
        review: reviewViewSchema.nullable(),
        attachments: z.array(assetViewSchema).max(32),
      })
      .passthrough(),
  }),
});

export class ContentOperationsClient implements JawStackApiClient {
  constructor(
    private readonly options: {
      fixture: () => FixtureId;
      base?: string;
      fetch?: typeof fetch;
      xhr?: () => XMLHttpRequest;
    },
  ) {}
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("x-content-ops-fixture", this.options.fixture());
    const response = await (this.options.fetch ?? fetch)(`${this.options.base ?? "/api"}${path}`, {
      ...init,
      redirect: "error",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
      headers,
    });
    return this.decode<T>(response);
  }
  private async decode<T>(response: Response): Promise<T> {
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new JawStackApiError("The API returned an unreadable response.", {
        code: "api.invalid_response",
        status: response.status,
      });
    }
    const envelope = z
      .object({
        ok: z.boolean(),
        data: z.unknown().optional(),
        error: z
          .object({ code: z.string(), message: z.string(), details: z.unknown().optional() })
          .optional(),
        meta: z.object({ correlationId: z.string() }).optional(),
      })
      .safeParse(body);
    if (!envelope.success)
      throw new JawStackApiError("The API returned an invalid response.", {
        code: "api.invalid_response",
        status: response.status,
      });
    if (!response.ok || !envelope.data.ok)
      throw new JawStackApiError(
        envelope.data.error?.message ?? "The request could not complete.",
        {
          code: envelope.data.error?.code ?? "http.error",
          status: response.status,
          details: envelope.data.error?.details,
          ...(envelope.data.meta ? { correlationId: envelope.data.meta.correlationId } : {}),
        },
      );
    return envelope.data.data as T;
  }
  async upload(
    contentId: string,
    assetId: string,
    file: File,
    signal: AbortSignal,
    progress: (percent: number) => void,
  ) {
    const path = `/uploads/${idSchema.parse(contentId)}/${idSchema.parse(assetId)}`;
    signal.throwIfAborted();
    const response = await new Promise<Response>((resolve, reject) => {
      const xhr = this.options.xhr?.() ?? new XMLHttpRequest();
      const abort = () => xhr.abort();
      const finish = (error?: Error) => {
        signal.removeEventListener("abort", abort);
        xhr.onload = xhr.onerror = xhr.onabort = xhr.ontimeout = null;
        xhr.upload.onprogress = null;
        if (error) reject(error);
        else {
          try {
            resolve(new Response(xhr.responseText, { status: xhr.status }));
          } catch {
            reject(
              new JawStackApiError("The upload returned an invalid response.", {
                code: "api.invalid_response",
                status: xhr.status,
              }),
            );
          }
        }
      };
      xhr.open("PUT", `${this.options.base ?? "/api"}${path}`);
      xhr.timeout = 30_000;
      xhr.setRequestHeader("x-content-ops-fixture", this.options.fixture());
      xhr.setRequestHeader("content-type", file.type);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0)
          progress(Math.min(100, Math.floor((event.loaded / event.total) * 100)));
      };
      xhr.onload = () => finish();
      xhr.onerror = () => finish(new TypeError("Upload interrupted."));
      xhr.onabort = () => finish(new DOMException("Upload cancelled.", "AbortError"));
      xhr.ontimeout = () => finish(new DOMException("Upload timed out.", "TimeoutError"));
      signal.addEventListener("abort", abort, { once: true });
      try {
        xhr.send(file);
      } catch {
        finish(new TypeError("Upload could not start."));
      }
    });
    const slot = assetViewSchema.parse(await this.decode(response));
    if (slot.assetId !== assetId || slot.contentId !== contentId || slot.status !== "ready")
      throw new Error("Upload verification did not return the requested attachment.");
    return slot;
  }
  async attachment(reference: AttachmentView, signal?: AbortSignal): Promise<Blob> {
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.base ?? "/api"}/assets/${idSchema.parse(reference.assetId)}/download?contentId=${idSchema.parse(reference.contentId)}`,
      {
        headers: { "x-content-ops-fixture": this.options.fixture() },
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) return this.decode(response);
    if (response.headers.get("content-type") !== reference.mediaType)
      throw new Error("Attachment type did not match its verified reference.");
    const bytes = await response.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    if (bytes.byteLength !== reference.size || digest !== reference.sha256)
      throw new Error("Attachment bytes did not match their verified reference.");
    return new Blob([bytes], { type: reference.mediaType });
  }
  async publication(id: string, signal?: AbortSignal) {
    const view = publicationViewSchema.parse(
      await this.request(`/content/${idSchema.parse(id)}/publication`, signal ? { signal } : {}),
    );
    if (
      view.artifact.contentId !== id ||
      view.artifact.content.attachments.some((asset) => asset.contentId !== id)
    )
      throw new Error("Publication target did not match its artifact.");
    return view;
  }
  async content(query: ContentQuery = {}, signal?: AbortSignal): Promise<ContentPage> {
    const parsed = contentQueryInput.parse(query);
    const params = new URLSearchParams(
      Object.entries(parsed).map(([key, value]) => [key, String(value)]),
    );
    return pageSchema.parse(await this.request(`/content?${params}`, signal ? { signal } : {}));
  }
  async calendar(query: CalendarQuery, signal?: AbortSignal): Promise<CalendarPage> {
    const q = calendarQueryInput.parse(query);
    const params = new URLSearchParams(
      Object.entries(q).map(([key, value]) => [key, String(value)]),
    );
    const page = z
      .object({ items: z.array(calendarRowSchema), nextCursor: z.string().optional() })
      .parse(await this.request(`/calendar?${params}`, signal ? { signal } : {}));
    if (page.items.some((row) => row.data.scheduledAt < q.from || row.data.scheduledAt >= q.before))
      throw new Error("Calendar returned a row outside the requested range.");
    return page;
  }
  async getContent(id: string, signal?: AbortSignal): Promise<ContentResource> {
    const data = resourceSchema.parse(
      await this.request(`/resources/contentItem/${idSchema.parse(id)}`, signal ? { signal } : {}),
    );
    if (data.resource.resourceId !== id || data.resource.state.contentId !== id)
      throw new JawStackApiError("The API returned a different resource.", {
        code: "api.invalid_response",
        status: 200,
      });
    return data.resource as ContentResource;
  }
  async operations(query: OperationsQuery = {}, signal?: AbortSignal): Promise<OperationsPage> {
    const q = operationsQueryInput.parse(query);
    const params = new URLSearchParams(
      Object.entries(q)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );
    const projection =
      q.view === "attempts"
        ? `contentItem.publicationAttempts${q.contentId ? `.${q.contentId}` : ""}`
        : q.view === "notifications"
          ? `contentItem.notifications${q.recipientId ? `.${q.recipientId}` : ""}`
          : "contentItem.failures";
    const schema =
      q.view === "attempts"
        ? publicationOperationSchema
        : q.view === "notifications"
          ? notificationViewSchema
          : failureSummarySchema;
    const page = z
      .object({
        items: z.array(
          z.object({
            projectionName: z.literal(projection),
            itemId: z.string(),
            sort: z.string(),
            data: schema,
          }),
        ),
        nextCursor: z.string().optional(),
      })
      .parse(await this.request(`/operations?${params}`, signal ? { signal } : {}));
    for (const row of page.items) {
      const data = row.data;
      const id =
        "attempt" in data
          ? data.attempt.claim.attemptId
          : "deliveryId" in data
            ? data.deliveryId
            : data.id;
      const contentId = "resourceId" in data ? data.resourceId : data.contentId;
      const status = "attempt" in data ? data.attempt.status : data.status;
      if (
        row.itemId !== id ||
        (q.contentId && q.contentId !== contentId) ||
        (q.status && q.status !== status) ||
        (q.recipientId && (!("recipientId" in data) || data.recipientId !== q.recipientId))
      )
        throw new Error("The API returned a different operation.");
    }
    return page;
  }
  async reviews(query: ReviewQuery = {}, signal?: AbortSignal): Promise<ReviewPage> {
    const params = new URLSearchParams(
      Object.entries(reviewQueryInput.parse(query)).map(([key, value]) => [key, String(value)]),
    );
    return z
      .object({ items: z.array(reviewRowSchema), nextCursor: z.string().optional() })
      .parse(await this.request(`/reviews?${params}`, signal ? { signal } : {}));
  }
  async getReview(id: string, signal?: AbortSignal): Promise<ReviewResource> {
    const data = z
      .object({
        resource: z.object({
          resourceType: z.literal("reviewTask"),
          resourceId: idSchema,
          version: versionSchema,
          createdAt: instantSchema,
          updatedAt: instantSchema,
          createdBy: z.string(),
          updatedBy: z.string(),
          state: reviewViewSchema,
        }),
      })
      .parse(
        await this.request(`/resources/reviewTask/${idSchema.parse(id)}`, signal ? { signal } : {}),
      );
    if (data.resource.resourceId !== id || data.resource.state.reviewId !== id)
      throw new JawStackApiError("The API returned a different review.", {
        code: "api.invalid_response",
        status: 200,
      });
    return data.resource;
  }
  async activityPage(
    type: "contentItem" | "reviewTask",
    id: string,
    input: { limit?: number; cursor?: string } = {},
    signal?: AbortSignal,
  ): Promise<ActivityPage> {
    const params = new URLSearchParams(
      Object.entries(pageInput.parse(input)).map(([key, value]) => [key, String(value)]),
    );
    const page = z
      .object({ items: z.array(activityViewSchema), nextCursor: z.string().optional() })
      .parse(
        await this.request(
          `/resources/${type}/${idSchema.parse(id)}/activity?${params}`,
          signal ? { signal } : {},
        ),
      );
    if (page.items.some((row) => row.resourceType !== type || row.resourceId !== id))
      throw new JawStackApiError("The API returned different activity.", {
        code: "api.invalid_response",
        status: 200,
      });
    return page;
  }
  async mutate<N extends CommandName>(
    name: N,
    input: CommandInput<N>,
    id?: string,
    key: string = crypto.randomUUID(),
  ): Promise<CommandResult> {
    const parsed = contentUi.commands[name].input.parse(input);
    return z
      .object({ resourceId: idSchema, version: versionSchema, assetId: idSchema.optional() })
      .parse(
        await this.command({
          resourceType: "contentItem",
          ...(id ? { resourceId: id } : {}),
          commandName: name,
          input: parsed,
          idempotencyKey: key,
        }),
      );
  }
  async list(resourceType: string, options: ListOptions = {}) {
    this.contentOnly(resourceType);
    return this.content(contentQueryInput.parse(options));
  }
  async get(resourceType: string, id: string) {
    this.contentOnly(resourceType);
    return this.getContent(id);
  }
  async activity(
    resourceType: string,
    id: string,
  ): Promise<{ items: ActivityRecord[]; nextCursor?: string | undefined }> {
    this.contentOnly(resourceType);
    const page = await this.activityPage("contentItem", id);
    return {
      ...page,
      items: page.items.map(({ summary, data, actor, causationId, ...item }) => ({
        ...item,
        ...(summary === undefined ? {} : { summary }),
        ...(data === undefined ? {} : { data }),
        ...(causationId === undefined ? {} : { causationId }),
        ...(actor === undefined
          ? {}
          : {
              actor: {
                subject: actor.subject,
                ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
              },
            }),
      })),
    };
  }
  async command<TInput, TOutput>(request: ExecuteCommandRequest<TInput>): Promise<TOutput> {
    this.contentOnly(request.resourceType);
    if (!Object.hasOwn(contentUi.commands, request.commandName))
      throw new Error("Command is not public.");
    const id = request.resourceId === undefined ? "" : `${idSchema.parse(request.resourceId)}/`;
    return this.request(`/resources/contentItem/${id}commands/${request.commandName}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: request.input,
        idempotencyKey: request.idempotencyKey ?? crypto.randomUUID(),
      }),
    });
  }
  private contentOnly(type: string) {
    if (type !== "contentItem") throw new Error("Unsupported resource type.");
  }
}
