import "@angular/compiler";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchJawStackApiClient, JawStackApiError } from "../src/index";

const client = () => new FetchJawStackApiClient({ apiBaseUrl: "https://example.test/api///" });
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("structured API failures", () => {
  it.each([
    { status: 409, code: "resource.conflict", details: { expectedVersion: 1, actualVersion: 2 } },
    { status: 403, code: "auth.forbidden", details: { requiredRole: "editor" } },
    { status: 401, code: "auth.missing", details: null },
    { status: 422, code: "content.snapshot_changed", details: ["revision"] },
  ])(
    "retains status, code, details, correlation, and Error compatibility: $code",
    async ({ status, code, details }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          response(
            {
              ok: false,
              error: { code, message: "Server message", details },
              meta: { requestId: "request_1", correlationId: "correlation_1" },
            },
            status,
          ),
        ),
      );
      const error = await client()
        .command({ resourceType: "contentItem", commandName: "approve", input: {} })
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(JawStackApiError);
      expect(error).toMatchObject({
        name: "JawStackApiError",
        message: "Server message",
        status,
        code,
        details,
        correlationId: "correlation_1",
      });
    },
  );

  it.each(["list", "get", "activity", "command"] as const)(
    "uses structured errors for %s",
    async (operation) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          response({ ok: false, error: { code: "auth.forbidden", message: "Denied" } }, 403),
        ),
      );
      const api = client();
      const call =
        operation === "list"
          ? api.list("contentItem")
          : operation === "get"
            ? api.get("contentItem", "item_1")
            : operation === "activity"
              ? api.activity("contentItem", "item_1")
              : api.command({ resourceType: "contentItem", commandName: "create", input: {} });
      await expect(call).rejects.toMatchObject({
        code: "auth.forbidden",
        status: 403,
        message: "Denied",
        correlationId: undefined,
      });
    },
  );

  it("preserves a legacy error message without requiring new server fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ error: { message: "Legacy failure" } }, 500)),
    );
    await expect(client().list("contentItem")).rejects.toMatchObject({
      message: "Legacy failure",
      code: "http.error",
      status: 500,
      details: undefined,
      correlationId: undefined,
    });
  });

  it.each([
    null,
    [],
    "failure",
    { error: null },
    { error: { message: 7, code: {}, details: false }, meta: { correlationId: 42 } },
  ])("handles malformed HTTP error envelopes: %j", async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(body, 502)),
    );
    await expect(client().list("contentItem")).rejects.toMatchObject({
      message: "JawStack API request failed: 502",
      code: "http.error",
      status: 502,
      correlationId: undefined,
    });
  });

  it.each([null, [], { ok: "true" }, { error: { message: "Protocol rejected" } }])(
    "rejects malformed successful envelopes: %j",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response(body)),
      );
      await expect(client().list("contentItem")).rejects.toMatchObject({
        code: "api.invalid_response",
        status: 200,
      });
    },
  );

  it.each([200, 503])(
    "turns invalid JSON into a safe structured response error (status %s)",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("<html>private upstream content</html>", { status })),
      );
      const error = await client()
        .list("contentItem")
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(JawStackApiError);
      expect(error).toMatchObject({
        code: status === 200 ? "api.invalid_response" : "http.error",
        status,
      });
      expect((error as Error).message).not.toContain("private upstream content");
    },
  );

  it("recognizes JSON parse errors across JavaScript realms", async () => {
    const failure: unknown = runInNewContext("new SyntaxError('Invalid JSON')");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw failure;
        },
      })),
    );
    await expect(client().list("contentItem")).rejects.toMatchObject({
      code: "http.error",
      status: 502,
    });
  });

  it("does not accept data from a failed HTTP status even with ok:true", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ ok: true, data: { items: [] } }, 403)),
    );
    await expect(client().list("contentItem")).rejects.toMatchObject({
      code: "http.error",
      status: 403,
    });
  });

  it("retains an application error code on an incorrectly successful HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          ok: false,
          error: { code: "resource.conflict", message: "Conflict" },
          meta: { correlationId: "correlation_1" },
        }),
      ),
    );
    await expect(client().list("contentItem")).rejects.toMatchObject({
      code: "resource.conflict",
      status: 200,
      correlationId: "correlation_1",
    });
  });

  it("propagates network, abort, and body transport failures unchanged", async () => {
    for (const failure of [
      new TypeError("Network failed"),
      new DOMException("Cancelled", "AbortError"),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw failure;
        }),
      );
      await expect(client().list("contentItem")).rejects.toBe(failure);
    }
    const failure = new TypeError("Body stream failed");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw failure;
        },
      })),
    );
    await expect(client().list("contentItem")).rejects.toBe(failure);
  });
});

describe("fetch client compatibility", () => {
  it("retains success payloads and legacy read paths", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      response({ ok: true, data: { items: [] } }),
    );
    vi.stubGlobal("fetch", fetch);
    const api = client();
    expect(await api.list("contentItem")).toEqual({ items: [] });
    expect(await api.get("contentItem", "item_1")).toEqual({ items: [] });
    expect(await api.activity("contentItem", "item_1")).toEqual({ items: [] });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://example.test/api/resources/contentItem",
      "https://example.test/api/resources/contentItem/item_1",
      "https://example.test/api/resources/contentItem/item_1/activity",
    ]);
  });

  it("preserves auth headers, command input, resource path, and idempotency key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      response({ ok: true, data: { saved: true } }),
    );
    vi.stubGlobal("fetch", fetch);
    const api = new FetchJawStackApiClient({
      apiBaseUrl: "/api",
      auth: () => ({
        subject: "author_1",
        roles: ["author"],
        displayName: "Author",
        tenantId: "tenant_1",
      }),
    });
    expect(
      await api.command({
        resourceType: "contentItem",
        resourceId: "item_1",
        commandName: "approve",
        input: { note: "Approved" },
        idempotencyKey: "key_1",
      }),
    ).toEqual({ saved: true });
    expect(fetch).toHaveBeenCalledWith("/api/resources/contentItem/item_1/commands/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-jawstack-subject": "author_1",
        "x-jawstack-roles": "author",
        "x-jawstack-display-name": "Author",
        "x-jawstack-tenant-id": "tenant_1",
      },
      body: JSON.stringify({ input: { note: "Approved" }, idempotencyKey: "key_1" }),
    });
  });
});
