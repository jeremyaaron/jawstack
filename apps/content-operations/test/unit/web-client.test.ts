import "@angular/compiler";
import { describe, expect, it, vi } from "vitest";
import { JawStackApiError } from "@jawstack/angular";
import { ContentOperationsClient } from "../../src/web/client";
import type { FixtureId } from "../../src/shared/identities";

const id = "10000000-0000-4000-8000-000000000001";
const envelope = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data, meta: { correlationId: "client-proof" } }));
describe("Content Operations client", () => {
  it("normalizes calendar UTC bounds and rejects oversized ranges and out-of-range rows", async () => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(envelope({ items: [] }));
    const client = new ContentOperationsClient({ fixture: () => "author_1", fetch: network });
    const query = {
      from: "2027-03-01T00:00:00.000-05:00",
      before: "2027-04-01T00:00:00.000-04:00",
      limit: 1,
    };
    await client.calendar(query);
    const params = new URL(String(network.mock.calls[0]![0]), "http://localhost").searchParams;
    expect(params.get("from")).toBe("2027-03-01T05:00:00.000Z");
    expect(params.get("before")).toBe("2027-04-01T04:00:00.000Z");
    await expect(
      client.calendar({ ...query, before: "2028-01-01T00:00:00.000Z" }),
    ).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(1);
    network.mockResolvedValueOnce(
      envelope({
        items: [
          {
            projectionName: "contentItem.calendar",
            itemId: id,
            sort: id,
            data: {
              title: "Outside",
              status: "scheduled",
              authorId: "author_1",
              revisionId: id,
              version: 4,
              createdAt: "2027-03-01T00:00:00.000Z",
              updatedAt: "2027-03-01T00:00:00.000Z",
              scheduledAt: "2027-04-01T04:00:00.000Z",
              timeZone: "UTC",
              generation: id,
            },
          },
        ],
      }),
    );
    await expect(client.calendar(query)).rejects.toThrow("outside the requested range");
  });
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
    const controller = new AbortController();
    await expect(client.content({}, controller.signal)).rejects.toBe(fault);
    const signal = network.mock.calls[0]![1]!.signal!;
    expect(signal).not.toBe(controller.signal);
    controller.abort();
    expect(signal.aborted).toBe(true);
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
  it("reports actual XHR progress without confusing transferred bytes with verified readiness", async () => {
    const xhr = {
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn(),
      abort: vi.fn(),
      upload: { onprogress: null as ((event: Partial<ProgressEvent>) => void) | null },
      timeout: 0,
      status: 503,
      responseText: JSON.stringify({
        ok: false,
        error: { code: "runtime.unavailable", message: "Interrupted" },
      }),
      onload: null as (() => void) | null,
      onabort: null as (() => void) | null,
    };
    const client = new ContentOperationsClient({
      fixture: () => "author_2",
      xhr: () => xhr as unknown as XMLHttpRequest,
    });
    const controller = new AbortController();
    const progress = vi.fn();
    const selected = new File(["proof"], "proof.pdf", { type: "application/pdf" });
    const pending = client.upload(id, id, selected, controller.signal, progress);
    expect(xhr.timeout).toBe(30_000);
    expect(xhr.open).toHaveBeenCalledWith("PUT", `/api/uploads/${id}/${id}`);
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("x-content-ops-fixture", "author_2");
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("content-type", "application/pdf");
    expect(xhr.send).toHaveBeenCalledWith(selected);
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 2, total: 5 });
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 5, total: 5 });
    expect(progress.mock.calls).toEqual([[40], [100]]);
    xhr.onload!();
    await expect(pending).rejects.toMatchObject({ status: 503, code: "runtime.unavailable" });
    expect(xhr.upload.onprogress).toBeNull();
    controller.abort();
    expect(xhr.abort).not.toHaveBeenCalled();
    const cancellation = new AbortController();
    const cancelled = client.upload(id, id, selected, cancellation.signal, progress);
    xhr.abort.mockImplementation(() => xhr.onabort?.());
    cancellation.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      client.upload(id, id, selected, cancellation.signal, progress),
    ).rejects.toMatchObject({ name: "AbortError" });
    xhr.status = 0;
    const invalid = client.upload(id, id, selected, new AbortController().signal, progress);
    xhr.onload!();
    await expect(invalid).rejects.toMatchObject({ code: "api.invalid_response" });
    xhr.send.mockImplementationOnce(() => {
      throw new Error("Cannot send");
    });
    await expect(
      client.upload(id, id, selected, new AbortController().signal, progress),
    ).rejects.toThrow("could not start");
  });
});
