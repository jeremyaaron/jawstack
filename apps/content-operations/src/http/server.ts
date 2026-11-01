import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { JawStackRuntimeError, type RuntimeErrorCode, type AuthContext } from "@jawstack/core";
import { fixtureIds, fixtureIdentities, fixtureAuth } from "../shared/identities";
import { idSchema, limits } from "../shared/validation";
import { eventIdentitySchema } from "../shared/events";
import { contentStateSchema } from "../shared/contracts";
import { publicValue } from "../shared/api";
import { createContentQueries, requireFixture } from "../application/queries";
import { createPrivateReads } from "../application/reads";
import { createSeeder } from "../application/seed";
import type { ApiRuntime } from "../application/api-runtime";
import {
  contentManifest,
  createContentJsonRouter,
  jsonFailure,
  jsonLimit,
  queryParameters,
} from "../application/json-router";

class HttpFailure extends JawStackRuntimeError {
  constructor(
    readonly status: number,
    code: RuntimeErrorCode,
    message: string,
  ) {
    super(code, message);
  }
}
function singleHeader(request: IncomingMessage, name: string) {
  if (
    request.rawHeaders.filter(
      (_, index) => index % 2 === 0 && request.rawHeaders[index]!.toLowerCase() === name,
    ).length > 1
  )
    throw new HttpFailure(400, "command.validation", "Duplicate request header.");
  const value = request.headers[name];
  if (Array.isArray(value))
    throw new HttpFailure(400, "command.validation", "Duplicate request header.");
  return value;
}
function byteStream(
  request: IncomingMessage,
  maximum: number,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const iterator = request.iterator({ destroyOnReturn: false });
      let size = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const next = await new Promise<IteratorResult<unknown>>((resolve, reject) => {
            const abort = () =>
              reject(
                new HttpFailure(
                  408,
                  "runtime.unavailable",
                  "Request body timed out or was interrupted.",
                ),
              );
            signal.addEventListener("abort", abort, { once: true });
            iterator
              .next()
              .then(resolve, reject)
              .finally(() => signal.removeEventListener("abort", abort));
          });
          if (next.done) break;
          if (!(next.value instanceof Uint8Array))
            throw new HttpFailure(400, "command.validation", "Invalid request body.");
          size += next.value.byteLength;
          if (size > maximum)
            throw new HttpFailure(
              413,
              "command.validation",
              "Request body exceeds its byte limit.",
            );
          yield next.value;
        }
      } finally {
        void iterator.return?.().catch(() => {});
        request.pause();
      }
    },
  };
}
async function jsonBody(request: IncomingMessage, signal: AbortSignal) {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      singleHeader(request, "content-type") ?? "",
    )
  )
    throw new HttpFailure(415, "command.validation", "Use application/json for this request.");
  const parts: Buffer[] = [];
  for await (const chunk of byteStream(request, jsonLimit, signal)) parts.push(Buffer.from(chunk));
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
  } catch {
    throw new JawStackRuntimeError("command.validation", "Invalid JSON request body.");
  }
}
export async function startContentApi(options: {
  runtime: ApiRuntime;
  host?: string;
  port?: number;
  webPort?: number;
  managed?: boolean;
  intervalMs?: number;
}) {
  if ((options.host ?? "127.0.0.1") !== "127.0.0.1")
    throw new Error("The development API binds only to 127.0.0.1.");
  const port = z
    .number()
    .int()
    .min(0)
    .max(65535)
    .parse(options.port ?? 4327);
  const webPort = z
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(options.webPort ?? 4326);
  const interval = z
    .number()
    .int()
    .min(10)
    .max(10_000)
    .parse(options.intervalMs ?? 1000);
  const runtime = options.runtime;
  const queries = createContentQueries({ repository: runtime.repository, clock: runtime.clock });
  const reads = createPrivateReads(runtime);
  const seed = createSeeder(runtime);
  const jsonRouter = createContentJsonRouter(runtime);
  const controllers = new Set<AbortController>();
  const handlers = new Set<Promise<void>>();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let processingFailed = false;
  const server = createServer(
    { maxHeaderSize: 16 * 1024, requestTimeout: 30_000, headersTimeout: 10_000 },
    (request, response) => {
      const work = handle(request, response);
      handlers.add(work);
      void work.finally(() => handlers.delete(work)).catch(() => response.destroy());
    },
  );
  server.maxHeadersCount = 100;
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  server.keepAliveTimeout = 1000;
  const headers = (
    response: ServerResponse,
    meta: { requestId: string; correlationId: string },
  ) => {
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("cross-origin-resource-policy", "same-origin");
    response.setHeader("content-security-policy", "default-src 'none'; sandbox");
    response.setHeader("x-request-id", meta.requestId);
    response.setHeader("x-correlation-id", meta.correlationId);
  };
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const meta = { requestId: randomUUID() as string, correlationId: randomUUID() as string };
    if (controllers.size >= 32) {
      headers(response, meta);
      response.statusCode = 503;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("connection", "close");
      response.once("finish", () => request.destroy());
      response.end(
        JSON.stringify({
          ok: false,
          error: { code: "runtime.unavailable", message: "API capacity reached; retry later." },
          meta,
        }),
      );
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    request.once("aborted", () => controller.abort());
    const write = (status: number, value: unknown) => {
      if (response.destroyed) return;
      headers(response, meta);
      response.statusCode = status;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(value));
    };
    const success = (data: unknown) => write(200, { ok: true, data, meta });
    let queryRoute = false;
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("API not listening.");
      const origins = new Set([`http://127.0.0.1:${address.port}`, `http://127.0.0.1:${webPort}`]);
      const host = singleHeader(request, "host");
      if (
        !host ||
        !origins.has(`http://${host}`) ||
        !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")
      )
        throw new HttpFailure(
          403,
          "auth.forbidden",
          "Only the configured loopback hosts are allowed.",
        );
      const origin = singleHeader(request, "origin");
      if (
        (origin !== undefined && !origins.has(origin)) ||
        singleHeader(request, "sec-fetch-site") === "cross-site"
      )
        throw new HttpFailure(403, "auth.forbidden", "Cross-origin requests are not allowed.");
      for (const [header, target] of [
        ["x-request-id", "requestId"],
        ["x-correlation-id", "correlationId"],
      ] as const) {
        const value = singleHeader(request, header);
        if (value !== undefined) meta[target] = eventIdentitySchema.parse(value);
      }
      if (
        !request.url?.startsWith("/") ||
        request.url.startsWith("//") ||
        request.url.includes("#") ||
        Buffer.byteLength(request.url) > 8192
      )
        throw new HttpFailure(414, "query.invalid", "Invalid request target.");
      const url = new URL(request.url, `http://${host}`);
      const parts = url.pathname
        .split("/")
        .slice(1)
        .map((part) => decodeURIComponent(part));
      if (parts.some((part) => /[/\\\p{Cc}]/u.test(part)))
        throw new JawStackRuntimeError("query.invalid", "Invalid route path.");
      const q = queryParameters(url);
      const method = request.method;
      if (!["GET", "POST", "PUT"].includes(method ?? ""))
        throw new HttpFailure(405, "command.rejected", "Method is not supported.");
      const length = singleHeader(request, "content-length");
      if (length !== undefined && !/^\d+$/.test(length))
        throw new HttpFailure(400, "command.validation", "Invalid content length.");
      const upload = method === "PUT" && parts[0] === "api" && parts[1] === "uploads";
      if (Number(length ?? 0) > (upload ? limits.assetBytes : jsonLimit))
        throw new HttpFailure(413, "command.validation", "Request body exceeds its byte limit.");
      if (
        singleHeader(request, "content-encoding") &&
        request.headers["content-encoding"] !== "identity"
      )
        throw new HttpFailure(
          415,
          "command.validation",
          "Encoded request bodies are not supported.",
        );
      if (method === "GET" && (Number(length ?? 0) > 0 || request.headers["transfer-encoding"]))
        throw new HttpFailure(400, "command.validation", "GET request bodies are not supported.");
      if (parts[0] !== "api")
        throw new JawStackRuntimeError("resource.not_found", "Route was not found.");
      if (
        method === "GET" &&
        parts.length === 2 &&
        ["health", "manifest", "fixtures"].includes(parts[1]!)
      ) {
        z.strictObject({}).parse(q);
        if (parts[1] === "health")
          success({
            status: processingFailed ? "degraded" : "ok",
            runtime: runtime.kind,
            processing:
              runtime.kind === "memory"
                ? options.managed === false
                  ? "explicit"
                  : "managed"
                : "external-workers",
          });
        else if (parts[1] === "manifest") success(contentManifest());
        else success(fixtureIdentities);
        return;
      }
      const fixture = singleHeader(request, "x-content-ops-fixture");
      if (!fixture) throw new JawStackRuntimeError("auth.missing", "Select a development fixture.");
      if (!fixtureIds.includes(fixture as (typeof fixtureIds)[number]))
        throw new JawStackRuntimeError("auth.forbidden", "Unknown development fixture.");
      const auth: AuthContext = fixtureAuth(fixture as (typeof fixtureIds)[number]);
      queryRoute = method === "GET";
      const routed = await jsonRouter({
        method: method!,
        parts,
        query: q,
        auth,
        meta,
        body: () => jsonBody(request, signal),
      });
      if (routed) {
        Object.assign(meta, routed.body.meta);
        write(routed.status, routed.body);
        return;
      }
      if (method === "POST" && url.pathname === "/api/development/seed") {
        requireFixture(auth, true);
        z.strictObject({}).parse(q);
        z.strictObject({ confirm: z.literal(true) }).parse(await jsonBody(request, signal));
        success(await seed());
        return;
      }
      if (upload && parts.length === 4) {
        z.strictObject({}).parse(q);
        const contentId = idSchema.parse(parts[2]);
        const assetId = idSchema.parse(parts[3]);
        const parent = await queries.load("contentItem", contentId);
        const state = contentStateSchema.parse(parent.state);
        const slot = state.attachments.find((asset) => asset.assetId === assetId);
        if (!slot || singleHeader(request, "content-type") !== slot.mediaType)
          throw new HttpFailure(
            415,
            "command.validation",
            "Upload media type must match the registered slot.",
          );
        success(
          publicValue(
            await runtime.upload({
              contentId,
              assetId,
              identity: auth,
              body: byteStream(request, limits.assetBytes, signal),
              signal,
            }),
          ),
        );
        return;
      }
      if (method === "GET") {
        queryRoute = true;
        if (parts.length === 4 && parts[1] === "assets" && parts[3] === "download") {
          const parsed = z.strictObject({ contentId: idSchema.optional() }).parse(q);
          const result = await reads.download(auth, idSchema.parse(parts[2]), parsed.contentId);
          headers(response, meta);
          response.setHeader("content-type", result.mediaType);
          response.setHeader("content-length", result.bytes.byteLength);
          const encoded = encodeURIComponent(result.filename).replace(
            /['()*]/g,
            (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
          );
          response.setHeader(
            "content-disposition",
            `${result.mediaType === "application/pdf" ? "attachment" : "inline"}; filename="attachment"; filename*=UTF-8''${encoded}`,
          );
          response.end(result.bytes);
          return;
        }
      }
      throw new JawStackRuntimeError("resource.not_found", "Route was not found.");
    } catch (error) {
      const failure = jsonFailure(error, meta, queryRoute);
      if (!request.readableEnded) {
        response.setHeader("connection", "close");
        response.once("finish", () => request.destroy());
      }
      write(error instanceof HttpFailure ? error.status : failure.status, failure.body);
    } finally {
      if (!response.writableFinished && !response.destroyed)
        await new Promise<void>((resolve) => {
          response.once("finish", resolve);
          response.once("close", resolve);
        });
      controllers.delete(controller);
    }
  }
  server.on("clientError", (_error, socket) => {
    if (socket.writable) {
      const body = JSON.stringify({
        ok: false,
        error: { code: "command.validation", message: "Invalid HTTP request." },
        meta: { requestId: randomUUID(), correlationId: randomUUID() },
      });
      socket.end(
        `HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await runtime.close?.();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("API failed to bind.");
  const work = () => {
    running = Promise.resolve()
      .then(() => runtime.tick!())
      .then(
        () => {
          processingFailed = false;
        },
        () => {
          processingFailed = true;
        },
      )
      .finally(() => {
        running = undefined;
        if (!closed) {
          timer = setTimeout(work, interval);
          timer.unref();
        }
      });
  };
  if (options.managed !== false && runtime.tick) {
    timer = setTimeout(work, 0);
    timer.unref();
  }
  let closing: Promise<void> | undefined;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      (closing ??= (async () => {
        closed = true;
        if (timer) clearTimeout(timer);
        for (const controller of controllers) controller.abort();
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        server.closeAllConnections();
        await stopped;
        await Promise.allSettled([...handlers]);
        await running;
        await runtime.close?.();
      })()),
  };
}
