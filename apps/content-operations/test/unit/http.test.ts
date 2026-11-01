import { request as nodeRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryApiRuntime } from "../../src/application/api-runtime";
import { createFixtureClock } from "../../src/application/runtime";
import { startContentApi } from "../../src/http/server";
import { contentStateSchema, type ContentState } from "../../src/shared/contracts";
import { type PublicValue } from "../../src/shared/api";
import { seedRunningApi } from "../../scripts/seed";
import { apiSettings } from "../../scripts/api";
import { seedItems } from "../../src/application/seed";
import { png } from "../support/editorial";

type Envelope = {
  ok: boolean;
  data: unknown;
  error?: { code: string; message: string; details?: unknown };
  meta: { requestId: string; correlationId: string };
};
type Content = { version: number; state: PublicValue<ContentState> };
const apis: Awaited<ReturnType<typeof startContentApi>>[] = [];
afterEach(async () => {
  await Promise.all(apis.splice(0).map((api) => api.close()));
  vi.restoreAllMocks();
});
async function setup(managed = true) {
  const clock = createFixtureClock("2026-10-31T12:00:00.000Z");
  const runtime = createMemoryApiRuntime({ clock: clock.now });
  const api = await startContentApi({ runtime, port: 0, managed, intervalMs: 10 });
  apis.push(api);
  const json = async (path: string, init: RequestInit = {}, actor = "author_1") => {
    const response = await fetch(`${api.baseUrl}${path}`, {
      ...init,
      headers: { "x-content-ops-fixture": actor, ...init.headers },
    });
    return { response, body: (await response.json()) as Envelope };
  };
  const command = async (
    name: string,
    input: unknown,
    id?: string,
    actor = "author_1",
    key = randomUUID(),
  ) => {
    const result = await json(
      `/api/resources/contentItem/${id ? `${id}/` : ""}commands/${name}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input, idempotencyKey: key }),
      },
      actor,
    );
    expect(result.body.ok, JSON.stringify(result.body.error)).toBe(true);
    return result.body.data as {
      resourceId: string;
      version: number;
      revisionId: string;
      assetId?: string;
    };
  };
  const current = async (id: string) =>
    ((await json(`/api/resources/contentItem/${id}`)).body.data as { resource: Content }).resource;
  return { clock, runtime, api, json, command, current };
}
async function until(check: () => Promise<boolean>) {
  for (let n = 0; n < 200; n++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("HTTP workflow did not settle.");
}
async function raw(
  base: string,
  path: string,
  headers: Record<string, string>,
  body?: Buffer,
  method = body ? "POST" : "GET",
) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
    (resolve, reject) => {
      const request = nodeRequest(`${base}${path}`, { method, headers }, (response) => {
        const parts: Buffer[] = [];
        response.on("data", (chunk) => parts.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            body: Buffer.concat(parts).toString(),
            headers: response.headers,
          }),
        );
      });
      request.on("error", reject);
      request.end(body);
    },
  );
}
describe("loopback HTTP workflow", () => {
  it("creates, uploads, reviews, schedules, publishes, previews and inspects through HTTP only", async () => {
    const h = await setup();
    expect((await h.json("/api/fixtures")).body.data).toHaveLength(4);
    const created = await h.command("create", {
      title: "HTTP release",
      body: "A reviewed publication.",
    });
    const asset = await h.command(
      "registerAsset",
      {
        expectedVersion: created.version,
        filename: "proof.png",
        mediaType: "image/png",
        expectedSize: png.length,
      },
      created.resourceId,
    );
    const uploaded = await h.json(`/api/uploads/${created.resourceId}/${asset.assetId}`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: Uint8Array.from(png),
    });
    expect(uploaded.body).toMatchObject({ ok: true, data: { status: "ready" } });
    const ready = await h.current(created.resourceId);
    expect(JSON.stringify(ready)).not.toMatch(/objectKey|fencingToken|bucket|endpoint/);
    await h.command(
      "submit",
      {
        expectedVersion: ready.version,
        assignedEditorId: "editor_1",
        dueAt: "2026-11-01T12:00:00.000Z",
      },
      created.resourceId,
    );
    await until(
      async () =>
        ((await h.json("/api/reviews?status=pending")).body.data as { items: unknown[] }).items
          .length === 1,
    );
    const submitted = await h.current(created.resourceId);
    await h.command(
      "approve",
      {
        expectedVersion: submitted.version,
        reviewId: submitted.state.review!.reviewId,
        revisionId: submitted.state.revisionId,
        note: "Approved over HTTP",
      },
      created.resourceId,
      "editor_1",
    );
    const approved = await h.current(created.resourceId);
    await h.command(
      "schedule",
      {
        expectedVersion: approved.version,
        reviewId: approved.state.approval!.reviewId,
        revisionId: approved.state.revisionId,
        scheduledAt: "2026-10-31T13:00:00.000Z",
        timeZone: "UTC",
      },
      created.resourceId,
      "editor_1",
    );
    expect(
      (
        await h.json(
          "/api/calendar?from=2026-10-31T12%3A00%3A00.000Z&before=2026-11-02T12%3A00%3A00.000Z",
        )
      ).body.data,
    ).toMatchObject({ items: [{ itemId: created.resourceId }] });
    h.clock.advance(3_600_000);
    await until(async () => (await h.current(created.resourceId)).state.status === "published");
    const preview = await h.json(`/api/content/${created.resourceId}/publication`);
    expect(preview.body).toMatchObject({
      ok: true,
      data: { artifact: { schemaVersion: 1, content: { title: "HTTP release" } } },
    });
    expect(JSON.stringify(preview.body)).not.toMatch(/objectKey|fencingToken|bucket/);
    const download = await fetch(`${h.api.baseUrl}/api/assets/${asset.assetId}/download`, {
      headers: { "x-content-ops-fixture": "author_2" },
    });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(png);
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    const ops = await h.json(
      `/api/operations?view=attempts&contentId=${created.resourceId}`,
      {},
      "editor_1",
    );
    expect(ops.body.data).toMatchObject({
      items: [{ data: { attempt: { status: "succeeded" } } }],
    });
    expect(
      (await h.json("/api/operations?view=notifications", {}, "editor_1")).body.data,
    ).toMatchObject({ items: expect.any(Array) });
    const history = await h.json(
      `/api/resources/contentItem/${created.resourceId}/activity?limit=2`,
    );
    expect(history.body.data).toMatchObject({
      items: expect.any(Array),
      nextCursor: expect.any(String),
    });
    const published = await h.current(created.resourceId);
    await h.command(
      "archive",
      { expectedVersion: published.version },
      created.resourceId,
      "editor_1",
    );
    expect((await h.json("/api/content?status=archived")).body.data).toMatchObject({
      items: [{ itemId: created.resourceId }],
    });
    expect((await h.json(`/api/content/${created.resourceId}/publication`)).response.status).toBe(
      200,
    );
  });
  it("returns repeatable conflict envelopes and ignores forged subject/role headers", async () => {
    const h = await setup(false);
    const key = randomUUID();
    const input = { title: "Owned draft", body: "Body" };
    const first = await h.command("create", input, undefined, "author_1", key);
    const repeated = await h.command("create", input, undefined, "author_1", key);
    expect(repeated).toEqual(first);
    const forbidden = await h.json(
      `/api/resources/contentItem/${first.resourceId}/commands/archive`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-jawstack-subject": "editor_1",
          "x-jawstack-roles": "editor",
        },
        body: JSON.stringify({ input: { expectedVersion: 1 }, idempotencyKey: randomUUID() }),
      },
    );
    expect(forbidden.response.status).toBe(403);
    const otherAuthor = await h.json(
      `/api/resources/contentItem/${first.resourceId}/commands/editDraft`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: { expectedVersion: 1, title: "Theft", body: "Body" },
          idempotencyKey: randomUUID(),
        }),
      },
      "author_2",
    );
    expect(otherAuthor.response.status).toBe(403);
    await h.command(
      "editDraft",
      { expectedVersion: 1, title: "Changed", body: "Body" },
      first.resourceId,
    );
    const conflict = await h.json(
      `/api/resources/contentItem/${first.resourceId}/commands/editDraft`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-correlation-id": "http-conflict" },
        body: JSON.stringify({
          input: { expectedVersion: 1, title: "Stale", body: "Body" },
          idempotencyKey: randomUUID(),
        }),
      },
    );
    expect(conflict.response.status).toBe(409);
    expect(conflict.body).toMatchObject({
      ok: false,
      error: { code: "resource.conflict", details: { expectedVersion: 1, actualVersion: 2 } },
      meta: { correlationId: "http-conflict" },
    });
  });
  it("excludes every internal command and never advertises service identities", async () => {
    const h = await setup(false);
    const created = await h.command("create", { title: "Draft", body: "Body" });
    for (const name of [
      "createSnapshot",
      "applySnapshot",
      "claimPublication",
      "completePublication",
      "failPublication",
      "completeUpload",
      "expireAsset",
      "recordReviewReminder",
      "requestDuePublication",
      "reconcilePublicationFailure",
    ]) {
      const result = await h.json(
        `/api/resources/contentItem/${created.resourceId}/commands/${name}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: {}, idempotencyKey: randomUUID() }),
        },
        "editor_1",
      );
      expect(result.response.status).toBe(403);
    }
    const manifest = JSON.stringify((await h.json("/api/manifest")).body.data);
    expect(manifest).not.toMatch(
      /completeUpload|claimPublication|content_publisher|failure_collector|fencingToken/,
    );
    expect((await h.json("/api/content", {}, "content_publisher")).response.status).toBe(403);
    expect(
      (
        await fetch(`${h.api.baseUrl}/api/content`, {
          headers: { "x-jawstack-subject": "editor_1", "x-jawstack-roles": "editor" },
        })
      ).status,
    ).toBe(401);
  });
  it("enforces Host/Origin, strict query fields, media types, and JSON byte limits", async () => {
    const h = await setup(false);
    for (const headers of [
      { host: "evil.example" },
      { origin: "http://evil.example" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
    ])
      expect((await raw(h.api.baseUrl, "/api/health", headers)).status).toBe(403);
    for (const path of [
      "/api/content?limit=101",
      "/api/content?limit=1&limit=2",
      "/api/content?projectionName=secrets",
      "/api/content?cursor=not-a-cursor",
      "/api/resources/contentItem/%zz",
    ])
      expect((await h.json(path)).response.status).toBe(400);
    const body = Buffer.alloc(256 * 1024 + 1, " ");
    const large = await raw(
      h.api.baseUrl,
      "/api/resources/contentItem/commands/create",
      {
        "content-type": "application/json",
        "x-content-ops-fixture": "author_1",
        "content-length": String(body.length),
      },
      body,
    );
    expect(large.status).toBe(413);
    expect(JSON.parse(large.body)).toMatchObject({ ok: false });
    expect(
      (
        await h.json("/api/resources/contentItem/commands/create", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        })
      ).response.status,
    ).toBe(415);
    expect(
      (
        await h.json("/api/resources/contentItem/commands/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not-json-private",
        })
      ).response.status,
    ).toBe(400);
  });
  it("seeds the same owned dataset idempotently through normal commands and never overwrites edits", async () => {
    const h = await setup();
    const port = new URL(h.api.baseUrl).port;
    const first = await seedRunningApi(["--runtime", "memory", "--port", port]);
    expect(first.created).toHaveLength(seedItems.length);
    const draft = await h.current(seedItems[0]!.id);
    await h.command(
      "editDraft",
      { expectedVersion: draft.version, title: "My own title", body: draft.state.body },
      seedItems[0]!.id,
    );
    const second = await seedRunningApi(["--runtime", "memory", "--port", port]);
    expect(second.created).toEqual([]);
    expect(second.skipped).toHaveLength(seedItems.length);
    expect((await h.current(seedItems[0]!.id)).state.title).toBe("My own title");
    await expect(seedRunningApi(["--runtime", "localstack", "--port", port])).rejects.toThrow();
    expect(
      (
        await h.json("/api/development/seed", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: true }),
        })
      ).response.status,
    ).toBe(403);
  });
  it("serves actual failure/notification summaries with editor-only filter composition", async () => {
    const h = await setup(false);
    const created = await h.command("create", {
      title: "Operations",
      body: "Private editorial body",
    });
    await h.command(
      "submit",
      { expectedVersion: 1, assignedEditorId: "editor_1", dueAt: "2026-11-01T12:00:00.000Z" },
      created.resourceId,
    );
    const event = h.runtime.app.persistence.store.outbox.find(
      (event) => event.eventType === "contentItem.reviewRequested",
    )!;
    await h.runtime.app.failures.collect("deliverNotification", event);
    const failures = await h.json(
      `/api/operations?view=failures&contentId=${created.resourceId}&status=failed`,
      {},
      "editor_1",
    );
    expect(failures.body).toMatchObject({
      ok: true,
      data: { items: [{ data: { status: "failed", consumer: "deliverNotification" } }] },
    });
    expect(JSON.stringify(failures.body)).not.toMatch(
      /Private editorial body|payload|objectKey|fencingToken/,
    );
    await h.runtime.app.drainUntilIdle();
    expect(
      (
        await h.json(
          `/api/operations?view=notifications&contentId=${created.resourceId}&recipientId=editor_1`,
          {},
          "editor_1",
        )
      ).body,
    ).toMatchObject({ ok: true, data: { items: [{ data: { recipientId: "editor_1" } }] } });
    expect((await h.json("/api/operations?view=failures")).response.status).toBe(403);
  });
  it("bounds chunked/invalid UTF-8 bodies without returning raw input", async () => {
    const h = await setup(false);
    const path = "/api/resources/contentItem/commands/create";
    const headers = {
      "content-type": "application/json",
      "x-content-ops-fixture": "author_1",
      "transfer-encoding": "chunked",
    };
    expect(
      (await raw(h.api.baseUrl, path, headers, Buffer.alloc(256 * 1024 + 1, " "))).status,
    ).toBe(413);
    const invalid = await raw(h.api.baseUrl, path, headers, Buffer.from([0xff, 0xfe]));
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalid.body)).toMatchObject({
      error: { message: "Invalid JSON request body." },
    });
    const oversized = await raw(
      h.api.baseUrl,
      "/api/uploads/x/y",
      { "content-type": "image/png", "content-length": String(10 * 1024 * 1024 + 1) },
      Buffer.alloc(0),
      "PUT",
    );
    expect(oversized.status).toBe(413);
  });
  it("reads only verified authoritative attachments, with safe PDF download headers", async () => {
    const h = await setup(false);
    const created = await h.command("create", { title: "Private attachments", body: "Body" });
    const bytes = Buffer.from("%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
    const registered = await h.command(
      "registerAsset",
      {
        expectedVersion: 1,
        filename: "review notes.pdf",
        mediaType: "application/pdf",
        expectedSize: bytes.length,
      },
      created.resourceId,
    );
    const url = `/api/assets/${registered.assetId}/download?contentId=${created.resourceId}`;
    expect((await h.json(url)).response.status).toBe(404);
    const rawState = (await h.runtime.repository.getState("contentItem", created.resourceId))!;
    const slot = contentStateSchema.parse(rawState.state).attachments[0]!;
    await h.runtime.objects.create(slot, bytes);
    expect((await h.json(url)).response.status).toBe(404); // Object existence alone is not authority.
    expect((await h.json(`/api/content/${created.resourceId}/publication`)).response.status).toBe(
      404,
    );
    expect((await h.json(`/api/${slot.objectKey}`)).response.status).toBe(404);
    const uploaded = await h.json(`/api/uploads/${created.resourceId}/${registered.assetId}`, {
      method: "PUT",
      headers: { "content-type": "application/pdf" },
      body: bytes,
    });
    expect(uploaded.body.ok).toBe(true);
    const result = await fetch(`${h.api.baseUrl}${url}`, {
      headers: { "x-content-ops-fixture": "author_2" },
    });
    expect(result.status).toBe(200);
    expect(Buffer.from(await result.arrayBuffer())).toEqual(bytes);
    expect(result.headers.get("content-disposition")).toBe(
      "attachment; filename=\"attachment\"; filename*=UTF-8''review%20notes.pdf",
    );
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(
      (await h.json(`/api/assets/${registered.assetId}/download?contentId=${randomUUID()}`))
        .response.status,
    ).toBe(404);
    const read = h.runtime.objects.read.bind(h.runtime.objects);
    vi.spyOn(h.runtime.objects, "read").mockImplementation(async (reference) => {
      const result = await read(reference);
      const latest = (await h.runtime.repository.getState("contentItem", created.resourceId))!;
      vi.spyOn(h.runtime.repository, "getState").mockResolvedValueOnce({
        ...latest,
        state: { ...contentStateSchema.parse(latest.state), attachments: [] },
      });
      return result;
    });
    expect((await h.json(url)).response.status).toBe(404); // Authority is checked again after readback.
  });
  it("keeps imports, configuration, and memory construction free of network/timer side effects", async () => {
    const { NodeHttpHandler } = await import("@smithy/node-http-handler");
    const { Server } = await import("node:net");
    const sdk = vi.spyOn(NodeHttpHandler.prototype, "handle").mockImplementation(() => {
      throw new Error("Unexpected SDK request");
    });
    const listen = vi.spyOn(Server.prototype, "listen");
    const timers = vi.spyOn(globalThis, "setTimeout");
    const network = vi.spyOn(globalThis, "fetch");
    await import("../../src/aws/api-runtime");
    expect(apiSettings(["memory"])).toMatchObject({ runtime: "memory", port: 4327 });
    expect(createMemoryApiRuntime().kind).toBe("memory");
    expect(sdk).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    expect(timers).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
  it("aborts stalled request bodies and waits for managed work before closing runtime", async () => {
    const h = await setup(false);
    const stalled = nodeRequest(`${h.api.baseUrl}/api/resources/contentItem/commands/create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-content-ops-fixture": "author_1",
        "transfer-encoding": "chunked",
      },
    });
    stalled.on("error", () => {});
    stalled.write("{");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.api.close();
    stalled.destroy();
    expect(h.api.server.listening).toBe(false);
    let release!: () => void;
    const tick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const close = vi.fn();
    const api = await startContentApi({
      runtime: { ...createMemoryApiRuntime(), tick, close },
      port: 0,
      intervalMs: 10,
    });
    apis.push(api);
    await until(async () => tick.mock.calls.length === 1);
    const stopped = api.close();
    expect(close).not.toHaveBeenCalled();
    release();
    await stopped;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(tick).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("sanitizes dependency faults and closes occupied-port/shutdown paths", async () => {
    const h = await setup(false);
    const spy = vi
      .spyOn(h.runtime.repository, "queryProjection")
      .mockRejectedValue(new Error("AWS_SECRET_ACCESS_KEY=private"));
    const failed = await h.json("/api/content");
    expect(failed.response.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toMatch(/AWS_SECRET|private|stack/);
    spy.mockRestore();
    await expect(
      startContentApi({
        runtime: createMemoryApiRuntime(),
        port: Number(new URL(h.api.baseUrl).port),
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    await expect(startContentApi({ runtime: h.runtime, host: "0.0.0.0" })).rejects.toThrow(
      "127.0.0.1",
    );
    await h.api.close();
    await h.api.close();
    expect(h.api.server.listening).toBe(false);
    for (const [args, env] of [
      [["aws"], {}],
      [["memory", "--port", "4326"], {}],
      [["localstack"], { AWS_PROFILE: "secret" }],
    ] as const)
      expect(() => apiSettings([...args], env)).toThrow();
  });
});
