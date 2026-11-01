import "@angular/compiler";
import { describe, expect, it, vi } from "vitest";
import { JawStackApiError } from "@jawstack/angular";
import { ContentOperationsClient } from "../../src/web/client";
import type { FixtureId } from "../../src/shared/identities";

const id = "10000000-0000-4000-8000-000000000001";
const envelope = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data, meta: { correlationId: "client-proof" } }));
describe("Content Operations client", () => {
  it("normalizes typed filters, retains empty continuation and resolves identity for each request", async () => {
    let actor: FixtureId = "author_1";
    const network = vi
      .fn<typeof fetch>()
      .mockResolvedValue(envelope({ items: [], nextCursor: "opaque" }));
    const client = new ContentOperationsClient({ fixture: () => actor, fetch: network });
    expect(await client.content({ title: "  TITLE  ", limit: 2 })).toEqual({
      items: [],
      nextCursor: "opaque",
    });
    expect(network.mock.calls[0]![0]).toBe("/api/content?limit=2&title=title");
    expect(new Headers(network.mock.calls[0]![1]!.headers).get("x-content-ops-fixture")).toBe(
      "author_1",
    );
    actor = "editor_2";
    network.mockResolvedValueOnce(envelope({ items: [] }));
    await client.list("contentItem");
    expect(new Headers(network.mock.calls[1]![1]!.headers).get("x-content-ops-fixture")).toBe(
      "editor_2",
    );
    await expect(client.content({ limit: 101 })).rejects.toThrow();
    await expect(client.list("reviewTask")).rejects.toThrow("Unsupported");
    expect(network).toHaveBeenCalledTimes(2);
  });
  it("preserves structured conflict details and correlation, not raw failure text", async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "resource.conflict",
            message: "Stale",
            details: { expectedVersion: 1, actualVersion: 2 },
          },
          meta: { correlationId: "trace-1" },
        }),
        { status: 409 },
      ),
    );
    const client = new ContentOperationsClient({ fixture: () => "author_1", fetch: network });
    await expect(
      client.mutate(
        "editDraft",
        { expectedVersion: 1, title: "Title", body: "Body" },
        id,
        "stable-key",
      ),
    ).rejects.toMatchObject({
      name: "JawStackApiError",
      status: 409,
      code: "resource.conflict",
      details: { expectedVersion: 1, actualVersion: 2 },
      correlationId: "trace-1",
    });
    expect(JSON.parse(network.mock.calls[0]![1]!.body as string).idempotencyKey).toBe("stable-key");
    network.mockResolvedValueOnce(new Response("private SDK body", { status: 503 }));
    try {
      await client.content();
    } catch (error) {
      expect(error).toBeInstanceOf(JawStackApiError);
      expect(String(error)).not.toContain("private SDK");
    }
    network.mockResolvedValueOnce(new Response("{}"));
    await expect(client.content()).rejects.toMatchObject({ code: "api.invalid_response" });
  });
  it("does not replace network, abort, or stream failures and rejects internal commands before fetch", async () => {
    const fault = new TypeError("offline");
    const network = vi.fn<typeof fetch>().mockRejectedValue(fault);
    const client = new ContentOperationsClient({ fixture: () => "author_1", fetch: network });
    await expect(client.content()).rejects.toBe(fault);
    const stream = new DOMException("aborted", "AbortError");
    network.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.reject(stream),
    } as Response);
    await expect(client.content()).rejects.toBe(stream);
    await expect(
      client.command({ resourceType: "contentItem", commandName: "completeUpload", input: {} }),
    ).rejects.toThrow("not public");
    expect(network).toHaveBeenCalledTimes(2);
  });
});
