import { randomUUID } from "node:crypto";
import { z } from "zod";
import { JawStackRuntimeError } from "@jawstack/core";
import {
  contentManifest,
  createContentJsonRouter,
  jsonFailure,
  jsonLimit,
  queryParameters,
  type RequestMeta,
} from "../../application/json-router";
import type { ApiRuntime } from "../../application/api-runtime";
import { fixtureAuth, fixtureIds, fixtureIdentities } from "../../shared/identities";
import { eventIdentitySchema } from "../../shared/events";
import { synthesisContext } from "./context";
import { createSynthesisRuntime } from "./runtime";

const requestSchema = z.object({
  version: z.literal("2.0"),
  rawPath: z.string().max(8192),
  rawQueryString: z.string().max(8192),
  headers: z.record(z.string(), z.string().max(8192)).optional(),
  requestContext: z.object({ http: z.object({ method: z.string() }) }),
  body: z.string().optional(),
  isBase64Encoded: z.boolean().optional(),
});
class TransportFailure extends JawStackRuntimeError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super("command.validation", message);
  }
}
export function createContentJsonLambdaHandler(
  factory: () => ApiRuntime | Promise<ApiRuntime> = () =>
    createSynthesisRuntime(synthesisContext("api")),
) {
  return async (input: unknown) => {
    synthesisContext("api");
    const meta: RequestMeta = { requestId: randomUUID(), correlationId: randomUUID() };
    let runtime: ApiRuntime | undefined;
    let queryRoute = false;
    const response = (statusCode: number, body: unknown, ids = meta) => ({
      statusCode,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cross-origin-resource-policy": "same-origin",
        "x-request-id": ids.requestId,
        "x-correlation-id": ids.correlationId,
      },
      body: JSON.stringify(body),
      isBase64Encoded: false,
    });
    try {
      const event = requestSchema.parse(input);
      if (
        !event.rawPath.startsWith("/") ||
        event.rawPath.startsWith("//") ||
        /[?#]/.test(event.rawPath) ||
        event.rawQueryString.includes("#") ||
        Buffer.byteLength(event.rawPath + event.rawQueryString) > 8192
      )
        throw new JawStackRuntimeError("query.invalid", "Invalid request target.");
      const headers: Record<string, string> = Object.create(null);
      for (const [name, value] of Object.entries(event.headers ?? {})) {
        const key = name.toLowerCase();
        if (Object.hasOwn(headers, key))
          throw new TransportFailure(400, "Duplicate request header.");
        headers[key] = value;
      }
      if (Object.keys(headers).length > 100 || Buffer.byteLength(JSON.stringify(headers)) > 16384)
        throw new TransportFailure(431, "Request headers exceed their limit.");
      for (const [key, name] of [
        ["x-request-id", "requestId"],
        ["x-correlation-id", "correlationId"],
      ] as const)
        if (headers[key] !== undefined) meta[name] = eventIdentitySchema.parse(headers[key]);
      const method = event.requestContext.http.method;
      if (!["GET", "POST"].includes(method))
        throw new TransportFailure(
          405,
          "Only JSON GET and POST are supported by this synthesis ingress.",
        );
      if (event.isBase64Encoded || Buffer.byteLength(event.body ?? "") > jsonLimit)
        throw new TransportFailure(
          event.isBase64Encoded ? 415 : 413,
          "Only bounded UTF-8 JSON bodies are supported.",
        );
      if (headers["content-encoding"] && headers["content-encoding"] !== "identity")
        throw new TransportFailure(415, "Encoded request bodies are not supported.");
      if (method === "GET" && event.body)
        throw new TransportFailure(400, "GET request bodies are not supported.");
      const parts = event.rawPath
        .split("/")
        .slice(1)
        .map((part) => decodeURIComponent(part));
      if (parts.some((part) => /[/\\\p{Cc}]/u.test(part)))
        throw new JawStackRuntimeError("query.invalid", "Invalid route path.");
      const q = queryParameters(
        new URL(
          `http://127.0.0.1${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`,
        ),
      );
      if (parts[0] !== "api")
        throw new JawStackRuntimeError("resource.not_found", "Route was not found.");
      if (
        method === "GET" &&
        parts.length === 2 &&
        ["health", "manifest", "fixtures"].includes(parts[1]!)
      ) {
        z.strictObject({}).parse(q);
        const data =
          parts[1] === "manifest"
            ? contentManifest()
            : parts[1] === "fixtures"
              ? fixtureIdentities
              : { status: "synthesis-only", runtime: "localstack", processing: "external-workers" };
        return response(200, { ok: true, data, meta });
      }
      const fixture = headers["x-content-ops-fixture"];
      if (!fixture) throw new JawStackRuntimeError("auth.missing", "Select a development fixture.");
      if (!fixtureIds.includes(fixture as (typeof fixtureIds)[number]))
        throw new JawStackRuntimeError("auth.forbidden", "Unknown development fixture.");
      runtime = await factory();
      queryRoute = method === "GET";
      const result = await createContentJsonRouter(runtime)({
        method,
        parts,
        query: q,
        auth: { ...fixtureAuth(fixture as (typeof fixtureIds)[number]), mode: "dev" },
        meta,
        body: async () => {
          if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers["content-type"] ?? ""))
            throw new TransportFailure(415, "Use application/json for this request.");
          try {
            return JSON.parse(event.body ?? "");
          } catch {
            throw new TransportFailure(400, "Invalid JSON request body.");
          }
        },
      });
      if (!result)
        throw new JawStackRuntimeError(
          "resource.not_found",
          "This route is not part of the synthesis JSON ingress.",
        );
      return response(result.status, result.body, result.body.meta);
    } catch (error) {
      const failure = jsonFailure(error, meta, queryRoute);
      return response(
        error instanceof TransportFailure ? error.status : failure.status,
        failure.body,
      );
    } finally {
      await runtime?.close?.();
    }
  };
}
