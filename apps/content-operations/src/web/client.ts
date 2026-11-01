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
  pageInput,
  type ContentQuery,
  type ReviewQuery,
  type PublicValue,
} from "../shared/api";
import { contentStatuses, reviewStatuses, type ContentState } from "../shared/contracts";
import { fixtureIds, editorIds, type FixtureId } from "../shared/identities";
import { reviewViewSchema, activityViewSchema, type ReviewView } from "../shared/review-views";
import { idSchema, instantSchema, versionSchema } from "../shared/validation";
import { contentUi } from "../shared/presentation";

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
export type CommandName = keyof typeof contentUi.commands;
export type CommandInput<N extends CommandName> = z.input<(typeof contentUi.commands)[N]["input"]>;
export type CommandResult = { resourceId: string; version: number };
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
        attachments: z
          .array(z.object({ assetId: idSchema, filename: z.string() }).passthrough())
          .max(32),
      })
      .passthrough(),
  }),
});

export class ContentOperationsClient implements JawStackApiClient {
  constructor(
    private readonly options: { fixture: () => FixtureId; base?: string; fetch?: typeof fetch },
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
  async content(query: ContentQuery = {}, signal?: AbortSignal): Promise<ContentPage> {
    const parsed = contentQueryInput.parse(query);
    const params = new URLSearchParams(
      Object.entries(parsed).map(([key, value]) => [key, String(value)]),
    );
    return pageSchema.parse(await this.request(`/content?${params}`, signal ? { signal } : {}));
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
    return z.object({ resourceId: idSchema, version: versionSchema }).parse(
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
