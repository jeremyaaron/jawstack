import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { JawStackRuntimeError, type WorkflowRuntime, type MemoryWorkflow } from "@jawstack/core";
import { fixtureAuth, isOperator } from "./workflow";
import { inventorySchema, keySchema, limits, readReport, serializeResult, uuid } from "./domain";
export type ReportApplication =
  | { kind: "memory"; workflow: MemoryWorkflow }
  | { kind: "localstack"; workflow: WorkflowRuntime };
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const statuses: Record<string, number> = {
  "auth.forbidden": 403,
  "auth.missing": 403,
  "resource.not_found": 404,
  "resource.conflict": 409,
  "idempotency.conflict": 409,
  "runtime.unavailable": 503,
  "resource.invalid_state": 503,
  "runtime.internal": 503,
};
const querySchema = z.strictObject({
  consumer: z.literal("buildInventory").optional(),
  reportId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});
async function body(request: IncomingMessage, signal: AbortSignal) {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)
  )
    throw new HttpError(415, "command.validation", "UTF-8 application/json is required.");
  if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity")
    throw new HttpError(415, "command.validation", "Compressed requests are not supported.");
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))))
    throw new HttpError(400, "command.validation", "Invalid content length.");
  if (Number(length ?? 0) > limits.bodyBytes)
    throw new HttpError(413, "command.validation", "Request exceeds 20 KiB.");
  const data = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAbort);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      cleanup();
      request.pause();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limits.bodyBytes)
        fail(new HttpError(413, "command.validation", "Request exceeds 20 KiB."));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = () =>
      fail(new HttpError(400, "command.validation", "Request body was interrupted."));
    const onAbort = () =>
      fail(new HttpError(400, "command.validation", "Request body deadline exceeded."));
    if (signal.aborted) return onAbort();
    request.on("data", onData).once("end", onEnd).once("error", onError).once("aborted", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as unknown;
  } catch {
    throw new HttpError(400, "command.validation", "Invalid UTF-8 JSON.");
  }
}
export async function startReportApi(
  app: ReportApplication,
  options: {
    port?: number;
    managed?: boolean;
    bodyTimeoutMs?: number;
    maxInFlight?: number;
  } = {},
) {
  const port = z
    .number()
    .int()
    .min(0)
    .max(65535)
    .parse(options.port ?? 4347);
  const timeout = z
    .number()
    .int()
    .min(1)
    .max(30000)
    .parse(options.bodyTimeoutMs ?? 30000);
  const maximum = z
    .number()
    .int()
    .min(1)
    .max(64)
    .parse(options.maxInFlight ?? 16);
  const controllers = new Set<AbortController>(),
    pending = new Set<Promise<void>>();
  let closing = false;
  let driver: ReturnType<MemoryWorkflow["start"]> | undefined;
  let driverFailed = false;
  const server = createServer(
    { maxHeaderSize: 16384, requestTimeout: 30000, headersTimeout: 10000 },
    (request, response) => {
      const handle = async () => {
        let meta = { requestId: randomUUID() as string, correlationId: randomUUID() as string };
        const controller = new AbortController();
        const send = (status: number, data: unknown, type = "application/json; charset=utf-8") => {
          let encoded = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
          if (encoded.length > 512 * 1024) {
            status = 503;
            type = "application/json; charset=utf-8";
            encoded = Buffer.from(
              JSON.stringify({
                ok: false,
                error: { code: "runtime.unavailable", message: "Response exceeds its bound." },
                meta,
              }),
            );
          }
          response.writeHead(status, {
            "content-type": type,
            "cache-control": "private, no-store",
            connection: "close",
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
            "x-request-id": meta.requestId,
            "x-correlation-id": meta.correlationId,
          });
          response.end(encoded);
        };
        try {
          if (closing || controllers.size >= maximum)
            throw new HttpError(503, "runtime.unavailable", "API capacity reached.");
          controllers.add(controller);
          const address = server.address();
          if (!address || typeof address === "string") throw new Error();
          const host = "127.0.0.1:" + address.port,
            origin = "http://" + host;
          const single = [
            "host",
            "origin",
            "content-type",
            "content-length",
            "x-report-runs-fixture",
            "x-request-id",
            "x-correlation-id",
          ];
          const names = request.rawHeaders
            .filter((_, index) => index % 2 === 0)
            .map((name) => name.toLowerCase());
          if (
            single.some((name) => names.filter((value) => value === name).length > 1) ||
            request.headers.host !== host ||
            (request.headers.origin && request.headers.origin !== origin) ||
            !request.url?.startsWith("/") ||
            request.url.startsWith("//") ||
            request.url.length > 8192
          )
            throw new HttpError(400, "command.validation", "Invalid loopback request context.");
          for (const [name, key] of [
            ["x-request-id", "requestId"],
            ["x-correlation-id", "correlationId"],
          ] as const) {
            const value = request.headers[name];
            if (value !== undefined) meta[key] = keySchema.parse(value);
          }
          const url = new URL(request.url, origin);
          if (url.origin !== origin || url.hash)
            throw new HttpError(400, "command.validation", "Invalid request URL.");
          const params = [...url.searchParams.keys()];
          if (new Set(params).size !== params.length)
            throw new HttpError(400, "command.validation", "Duplicate query parameters.");
          if (
            request.method === "GET" &&
            (request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? 0))
          )
            throw new HttpError(400, "command.validation", "GET bodies are not supported.");
          if (request.method === "GET" && url.pathname === "/api/health" && !url.search)
            return send(driverFailed ? 503 : 200, {
              ok: !driverFailed,
              data: {
                status: driverFailed ? "unavailable" : "ok",
                runtime: app.kind,
                processing:
                  app.kind === "memory" ? (driver ? "managed" : "manual") : "external-workers",
              },
              meta,
            });
          const auth = fixtureAuth(String(request.headers["x-report-runs-fixture"] ?? ""));
          const success = (data: unknown) => send(200, { ok: true, data, meta });
          if (request.method === "POST" && url.pathname === "/api/reports" && !url.search) {
            const input = z
              .strictObject({ input: inventorySchema, idempotencyKey: keySchema })
              .parse(
                await body(
                  request,
                  AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]),
                ),
              );
            const result = await app.workflow.dispatch(
              {
                resourceType: "reportRun",
                commandName: "request",
                ...input,
                ...meta,
                requestContext: {},
              },
              auth,
            );
            meta = result.meta;
            return send(result.ok ? 200 : (statuses[result.error.code] ?? 400), result);
          }
          const match = /^\/api\/reports\/([^/]+)(\/result)?$/.exec(url.pathname);
          if (request.method === "GET" && match && !url.search) {
            const id = uuid.parse(match[1]);
            const row = readReport(await app.workflow.repository.getState("reportRun", id), id);
            if (auth.subject !== row.state.requester && !isOperator(auth))
              throw new JawStackRuntimeError(
                "auth.forbidden",
                "Report belongs to another requester.",
              );
            if (match[2]) {
              if (row.state.status !== "completed")
                throw new JawStackRuntimeError("resource.conflict", "Report is not complete.");
              const result = serializeResult(row.state.result);
              response.setHeader(
                "digest",
                "sha-256=" + Buffer.from(result.digest, "hex").toString("base64"),
              );
              response.setHeader("etag", '"' + result.digest + '"');
              return send(200, result.bytes);
            }
            return success({
              resource: row,
              delivery: {
                consumer: "buildInventory",
                reportId: id,
                ...(isOperator(auth) ? { operations: "/api/operations?reportId=" + id } : {}),
              },
            });
          }
          if (request.method === "GET" && url.pathname === "/api/operations") {
            if (!isOperator(auth))
              throw new JawStackRuntimeError("auth.forbidden", "Operator fixture required.");
            const q = querySchema.parse(Object.fromEntries(url.searchParams)),
              scope = JSON.stringify({
                consumer: q.consumer ?? null,
                reportId: q.reportId ?? null,
              });
            let inner: string | undefined;
            if (q.cursor) {
              const cursor = z
                .strictObject({
                  version: z.literal(1),
                  scope: z.string(),
                  inner: z.string().min(1).max(4096),
                })
                .parse(JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8")));
              if (cursor.scope !== scope)
                throw new HttpError(400, "query.invalid", "Cursor belongs to different filters.");
              inner = cursor.inner;
            }
            const items = [];
            const limit = q.limit ?? 50;
            let evaluated = 0,
              pages = 0;
            const seen = new Set<string>();
            do {
              const page = await app.workflow.operations.inspect(auth, {
                limit: Math.min(limit - items.length, 200 - evaluated),
                ...(inner ? { cursor: inner } : {}),
              });
              if (!("items" in page)) throw new Error();
              evaluated += page.items.length;
              items.push(
                ...page.items.filter(
                  (row) =>
                    (!q.consumer || row.consumer === q.consumer) &&
                    (!q.reportId || row.resourceId === q.reportId),
                ),
              );
              inner = page.nextCursor;
              if (inner && seen.has(inner))
                throw new JawStackRuntimeError(
                  "runtime.unavailable",
                  "Repeated operations cursor.",
                );
              if (inner) seen.add(inner);
            } while (inner && evaluated < 200 && ++pages < 20 && items.length < limit);
            return success({
              items,
              ...(inner
                ? {
                    nextCursor: Buffer.from(
                      JSON.stringify({
                        version: 1,
                        scope,
                        inner,
                      }),
                    ).toString("base64url"),
                  }
                : {}),
            });
          }
          const replay = /^\/api\/operations\/([a-f0-9]{64})\/replay$/.exec(url.pathname);
          if (request.method === "POST" && replay && !url.search) {
            if (!isOperator(auth))
              throw new JawStackRuntimeError("auth.forbidden", "Operator fixture required.");
            const input = z
              .strictObject({ requestId: uuid })
              .parse(
                await body(
                  request,
                  AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]),
                ),
              );
            return success(await app.workflow.operations.replay(replay[1]!, auth, input.requestId));
          }
          throw new HttpError(404, "resource.not_found", "Route was not found.");
        } catch (error) {
          const code =
            error instanceof HttpError || error instanceof JawStackRuntimeError
              ? error.code
              : error instanceof z.ZodError || error instanceof SyntaxError
                ? "command.validation"
                : "runtime.unavailable";
          const status = error instanceof HttpError ? error.status : (statuses[code] ?? 400);
          if (!response.headersSent && !response.destroyed)
            send(status, {
              ok: false,
              error: {
                code,
                message:
                  status === 503
                    ? "Report service unavailable."
                    : error instanceof JawStackRuntimeError || error instanceof HttpError
                      ? error.message
                      : "Invalid report request.",
              },
              meta,
            });
        } finally {
          controllers.delete(controller);
          response.once("finish", () => {
            if (!request.complete) request.destroy();
          });
        }
      };
      const work = handle();
      pending.add(work);
      void work.finally(() => pending.delete(work)).catch(() => response.destroy());
    },
  );
  server.maxHeadersCount = 64;
  server.on("clientError", (_error, socket) => {
    if (!socket.writable || socket.destroyed) return;
    const data = JSON.stringify({
      ok: false,
      error: { code: "command.validation", message: "Invalid HTTP request." },
      meta: { requestId: randomUUID(), correlationId: randomUUID() },
    });
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: " +
        Buffer.byteLength(data) +
        "\r\n\r\n" +
        data,
    );
  });
  server.maxConnections = 64;
  server.keepAliveTimeout = 1000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    if (app.kind === "memory" && options.managed !== false) {
      driver = app.workflow.start({ intervalMs: 1000 });
      void driver.done.catch(() => {
        driverFailed = true;
      });
    }
  } catch (error) {
    server.close();
    await app.workflow.close();
    throw error;
  }
  const actual = server.address();
  if (!actual || typeof actual === "string") throw new Error("API did not bind.");
  let close: Promise<void> | undefined;
  return {
    url: "http://127.0.0.1:" + actual.port,
    close: () =>
      (close ??= (async () => {
        closing = true;
        for (const controller of controllers) controller.abort();
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        const work = (async () => {
          try {
            await driver?.stop();
          } finally {
            await app.workflow.close();
          }
          await Promise.all([...pending]);
          await stopped;
        })();
        let timer: ReturnType<typeof setTimeout>;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            server.closeAllConnections();
            reject(new JawStackRuntimeError("runtime.unavailable", "API close deadline exceeded."));
          }, 5000);
        });
        try {
          await Promise.race([work, deadline]);
        } finally {
          clearTimeout(timer!);
        }
      })()),
  };
}
