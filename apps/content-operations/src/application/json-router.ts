import { z } from "zod";
import {
  createManifest,
  JawStackRuntimeError,
  type AuthContext,
  type RuntimeErrorCode,
  type ApiError,
} from "@jawstack/core";
import { createContentOperationsResources } from "../domain/resources";
import { contentUi } from "../shared/presentation";
import { publicValue } from "../shared/api";
import { idSchema } from "../shared/validation";
import { keyComponentSchema } from "./persistence";
import { createContentQueries } from "./queries";
import { createPrivateReads } from "./reads";
import type { ApiRuntime } from "./api-runtime";

export const jsonLimit = 256 * 1024;
export type RequestMeta = { requestId: string; correlationId: string };
const statuses: Record<RuntimeErrorCode, number> = {
  "command.validation": 400,
  "query.invalid": 400,
  "command.rejected": 422,
  "auth.missing": 401,
  "auth.forbidden": 403,
  "resource.not_found": 404,
  "resource.conflict": 409,
  "resource.invalid_state": 422,
  "idempotency.conflict": 409,
  "runtime.internal": 500,
  "runtime.unavailable": 503,
};
const commandBody = z.strictObject({ input: z.unknown(), idempotencyKey: keyComponentSchema });
const resourceTypeSchema = z.enum(["contentItem", "reviewTask", "asset"]);
const safeDetails = (details: unknown) => {
  const parsed = z
    .object({
      expectedVersion: z.number().int().positive(),
      actualVersion: z.number().int().positive(),
    })
    .safeParse(details);
  return parsed.success ? parsed.data : undefined;
};
export function jsonFailure(error: unknown, meta: RequestMeta, queryRoute = false) {
  const code: RuntimeErrorCode =
    error instanceof URIError
      ? "query.invalid"
      : error instanceof z.ZodError
        ? queryRoute
          ? "query.invalid"
          : "command.validation"
        : error instanceof JawStackRuntimeError
          ? error.code
          : "runtime.internal";
  const message = ["runtime.internal", "runtime.unavailable", "resource.invalid_state"].includes(
    code,
  )
    ? "The operation could not complete. Retry or inspect local operations."
    : error instanceof z.ZodError
      ? "Invalid request fields."
      : error instanceof JawStackRuntimeError
        ? error.message
        : "The request could not complete.";
  const details = error instanceof JawStackRuntimeError ? safeDetails(error.details) : undefined;
  const body: ApiError = {
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
    meta,
  };
  return { status: statuses[code], body };
}
export function contentManifest() {
  const value = createManifest({
    appName: "content-operations",
    stage: "local",
    resources: createContentOperationsResources(),
    stable: true,
    auth: { mode: "dev", provider: "fixtures" },
    costProfile: {},
  });
  return {
    ...value,
    resources: value.resources.map((resource) => ({
      ...resource,
      commands: resource.commands.filter(
        (command) =>
          resource.name === "contentItem" && Object.hasOwn(contentUi.commands, command.name),
      ),
      workers: [],
      schedules: [],
    })),
  };
}
export function queryParameters(url: URL) {
  const result: Record<string, string> = {};
  for (const [name, value] of url.searchParams) {
    if (Object.hasOwn(result, name))
      throw new JawStackRuntimeError("query.invalid", "Duplicate query parameter.");
    Object.defineProperty(result, name, { value, enumerable: true });
  }
  return result;
}
export function createContentJsonRouter(runtime: ApiRuntime) {
  const queries = createContentQueries({ repository: runtime.repository, clock: runtime.clock });
  const reads = createPrivateReads(runtime);
  return async (request: {
    method: string;
    parts: string[];
    query: Record<string, string>;
    auth: AuthContext;
    meta: RequestMeta;
    body: () => Promise<unknown>;
  }) => {
    const { method, parts, query: q, auth, meta } = request;
    const success = (data: unknown) => ({ status: 200, body: { ok: true as const, data, meta } });
    if (parts[0] !== "api") return undefined;
    if (method === "POST" && parts[1] === "resources") {
      z.strictObject({}).parse(q);
      const creating =
        parts.length === 5 &&
        parts[2] === "contentItem" &&
        parts[3] === "commands" &&
        parts[4] === "create";
      const updating =
        parts.length === 6 &&
        parts[2] === "contentItem" &&
        parts[4] === "commands" &&
        parts[5] !== "create";
      const name = creating ? "create" : updating ? parts[5]! : "";
      if (!Object.hasOwn(contentUi.commands, name))
        throw new JawStackRuntimeError(
          "auth.forbidden",
          "This command is not exposed through HTTP.",
        );
      const body = commandBody.parse(await request.body());
      const result = await runtime.dispatch(
        {
          resourceType: "contentItem",
          ...(updating ? { resourceId: idSchema.parse(parts[3]) } : {}),
          commandName: name,
          input: body.input,
          idempotencyKey: body.idempotencyKey,
          requestId: meta.requestId,
          correlationId: meta.correlationId,
          requestContext: {},
        },
        auth,
      );
      if (!result.ok)
        throw new JawStackRuntimeError(
          result.error.code,
          result.error.message,
          safeDetails(result.error.details),
        );
      return { status: 200, body: { ...result, data: publicValue(result.data) } };
    }
    if (method !== "GET") return undefined;
    if (
      parts.length === 2 &&
      ["content", "reviews", "calendar", "operations"].includes(parts[1]!)
    ) {
      const name = parts[1] as "content" | "reviews" | "calendar" | "operations";
      return success(await queries[name](auth, q));
    }
    if (
      parts[1] === "resources" &&
      (parts.length === 4 || (parts.length === 5 && parts[4] === "activity"))
    ) {
      const type = resourceTypeSchema.parse(parts[2]);
      const id = idSchema.parse(parts[3]);
      if (parts.length === 4) {
        z.strictObject({}).parse(q);
        return success(await queries.resource(auth, type, id));
      }
      return success(await queries.activity(auth, type, id, q));
    }
    if (parts.length === 4 && parts[1] === "content" && parts[3] === "publication") {
      z.strictObject({}).parse(q);
      return success(await reads.publication(auth, idSchema.parse(parts[2])));
    }
    return undefined;
  };
}
