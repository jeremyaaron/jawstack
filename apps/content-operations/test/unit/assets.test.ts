import { describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import type { AuthContext } from "@jawstack/core";
import { createContentDispatch } from "../../src/application/dispatch";
import { createMemoryPersistence } from "../../src/application/memory";
import { createMemoryObjectStore, inspectAsset } from "../../src/application/object-store";
import { createUploadService } from "../../src/application/uploads";
import { assetJanitorIdentity, uploadVerifierIdentity } from "../../src/domain/resources";
import { assetProjectorIdentity } from "../../src/domain/asset-resource";
import { assetUi } from "../../src/shared/presentation";
import { assetSlotSchema, type AssetSlot } from "../../src/shared/assets";
import { contentStateSchema, type ContentState } from "../../src/shared/contracts";
import { limits } from "../../src/shared/validation";
import { fixtureAuth, type FixtureId } from "../../src/shared/identities";

const contentId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1kAAAAASUVORK5CYII=",
  "base64",
);
const service = (identity: { subject: string; role: string }): AuthContext => ({
  subject: identity.subject,
  roles: [identity.role],
  claims: {},
  mode: "test",
});
async function harness() {
  const memory = createMemoryPersistence();
  const objects = createMemoryObjectStore();
  let instant = new Date("2026-10-31T12:00:00.000Z");
  const clock = () => new Date(instant);
  const dispatch = createContentDispatch({ persistence: memory.factory, clock });
  let key = 0;
  const run = (
    commandName: string,
    input: unknown,
    actor: FixtureId | AuthContext = "author_1",
    id = contentId,
    resourceType = "contentItem",
  ) =>
    dispatch(
      {
        resourceType,
        resourceId: id,
        commandName,
        input,
        requestContext: {},
        idempotencyKey: `command:${++key}`,
      },
      typeof actor === "string" ? fixtureAuth(actor) : actor,
    );
  const current = async () =>
    (await memory.repository.getState<ContentState>("contentItem", contentId))!;
  expect((await run("create", { title: "Attachment draft", body: "Body" })).ok).toBe(true);
  const register = async (filename = "photo.png", expectedSize = png.length) => {
    const before = await current();
    const result = await run("registerAsset", {
      expectedVersion: before.version,
      filename,
      expectedSize,
      mediaType: "image/png",
    });
    expect(result.ok).toBe(true);
    return (await current()).state.attachments.at(-1)!;
  };
  const upload = createUploadService({ repository: memory.repository, dispatch, objects, clock });
  const send = (asset: AssetSlot, body = png, identity = fixtureAuth("author_1")) =>
    upload({ contentId, assetId: asset.assetId, body, identity });
  return {
    memory,
    objects,
    clock,
    dispatch,
    run,
    current,
    register,
    upload,
    send,
    advance: (ms: number) => {
      instant = new Date(instant.getTime() + ms);
    },
  };
}

describe("authoritative attachment lifecycle", () => {
  it("registers generated identities, verifies readiness, freezes review references, and retains approved bytes", async () => {
    const h = await harness();
    const before = await h.current();
    const slot = await h.register();
    expect(slot).toMatchObject({ status: "pending", uploaderId: "author_1", sourceVersion: 2 });
    expect(slot.objectKey).toBe(`assets/${contentId}/${slot.assetId}/original`);
    expect((await h.current()).state.revisionId).not.toBe(before.state.revisionId);
    const revision = (await h.current()).state.revisionId;
    expect(
      await h.run("submit", {
        expectedVersion: 2,
        assignedEditorId: "editor_1",
        dueAt: "2026-11-01T12:00:00.000Z",
      }),
    ).toMatchObject({ ok: false, error: { code: "command.rejected" } });
    const ready = await h.send(slot);
    expect(ready.status).toBe("ready");
    expect((await h.current()).state.revisionId).toBe(revision);
    const version = (await h.current()).version;
    expect(await h.send(slot)).toEqual(ready);
    expect((await h.current()).version).toBe(version);
    expect(
      (
        await h.run("submit", {
          expectedVersion: version,
          assignedEditorId: "editor_1",
          dueAt: "2026-11-01T12:00:00.000Z",
        })
      ).ok,
    ).toBe(true);
    const submitted = await h.current();
    expect(submitted.state.review!.submitted.attachments).toEqual([
      {
        contentId,
        assetId: slot.assetId,
        objectKey: slot.objectKey,
        mediaType: "image/png",
        filename: "photo.png",
        size: png.length,
        sha256: ready.verified!.sha256,
      },
    ]);
    expect(
      (
        await h.run(
          "approve",
          {
            expectedVersion: submitted.version,
            reviewId: submitted.state.review!.reviewId,
            revisionId: revision,
            note: "Approved",
          },
          "editor_1",
        )
      ).ok,
    ).toBe(true);
    await expect(h.send(slot)).rejects.toMatchObject({ code: "command.rejected" });
    expect(
      await h.run("removeAsset", {
        expectedVersion: (await h.current()).version,
        assetId: slot.assetId,
      }),
    ).toMatchObject({ ok: false });
    expect(Buffer.from(await h.objects.read(inspectAsset(slot, png)))).toEqual(png);
    expect("delete" in h.objects).toBe(false);
  });

  it("removes and expires slots as bounded tombstones with complete facts and revision changes", async () => {
    const h = await harness();
    const slot = await h.register();
    const ready = await h.send(slot);
    const before = await h.current();
    expect(
      (await h.run("removeAsset", { expectedVersion: before.version, assetId: slot.assetId })).ok,
    ).toBe(true);
    const removed = await h.current();
    expect(removed.state.revisionId).not.toBe(before.state.revisionId);
    expect(removed.state.attachments[0]).toMatchObject({
      status: "removed",
      verified: ready.verified,
      sourceVersion: removed.version,
    });
    expect(h.memory.store.outbox.at(-1)).toMatchObject({
      eventType: "contentItem.assetRemoved",
      schemaVersion: 1,
      payload: removed.state.attachments[0],
    });
    expect(Buffer.from(await h.objects.read(inspectAsset(slot, png)))).toEqual(png);
    const pending = await h.register();
    expect(
      await h.run(
        "expireAsset",
        { expectedVersion: (await h.current()).version, assetId: pending.assetId },
        service(assetJanitorIdentity),
      ),
    ).toMatchObject({ ok: false, error: { code: "command.rejected" } });
    h.advance(limits.uploadLifetimeMs);
    await expect(h.send(pending)).rejects.toMatchObject({ code: "command.rejected" });
    expect(
      (
        await h.run(
          "expireAsset",
          { expectedVersion: (await h.current()).version, assetId: pending.assetId },
          service(assetJanitorIdentity),
        )
      ).ok,
    ).toBe(true);
    expect((await h.current()).state.attachments[1]).toMatchObject({
      status: "expired",
      verified: null,
    });
    expect(h.memory.store.outbox.at(-1)?.eventType).toBe("contentItem.assetExpired");
    expect(
      (
        await h.run("submit", {
          expectedVersion: (await h.current()).version,
          assignedEditorId: "editor_1",
          dueAt: "2026-11-01T12:00:00.000Z",
        })
      ).ok,
    ).toBe(true);
    expect((await h.current()).state.review!.submitted.attachments).toEqual([]);
  });

  it.each([
    "../evil.png",
    "a/b.png",
    "a\\b.png",
    "<script>.png",
    "a\r\nHeader: x",
    ".",
    "..",
    "x\u202epng",
    "x".repeat(256),
    "bad\ud800.png",
  ])("rejects unsafe filename %j before committing", async (filename) => {
    const h = await harness();
    expect(
      await h.run("registerAsset", {
        expectedVersion: 1,
        filename,
        mediaType: "image/png",
        expectedSize: 10,
      }),
    ).toMatchObject({ ok: false, error: { code: "command.validation" } });
    expect((await h.current()).version).toBe(1);
  });

  it("bounds active slots and retained tombstones, never silently evicting an old reference", async () => {
    const h = await harness();
    for (let i = 0; i < limits.activeAssets; i++) await h.register();
    const input = {
      expectedVersion: (await h.current()).version,
      filename: "photo.png",
      mediaType: "image/png",
      expectedSize: png.length,
    };
    expect(await h.run("registerAsset", input)).toMatchObject({
      ok: false,
      error: { code: "command.rejected" },
    });
    for (const slot of (await h.current()).state.attachments)
      expect(
        (
          await h.run("removeAsset", {
            expectedVersion: (await h.current()).version,
            assetId: slot.assetId,
          })
        ).ok,
      ).toBe(true);
    for (let i = limits.activeAssets; i < limits.retainedAssets; i++) {
      const slot = await h.register();
      expect(
        (
          await h.run("removeAsset", {
            expectedVersion: (await h.current()).version,
            assetId: slot.assetId,
          })
        ).ok,
      ).toBe(true);
    }
    expect((await h.current()).state.attachments).toHaveLength(limits.retainedAssets);
    expect(
      await h.run("registerAsset", { ...input, expectedVersion: (await h.current()).version }),
    ).toMatchObject({ ok: false, error: { code: "command.rejected" } });
  });

  it("rejects forged completion, cross-content references, invalid size, roles and ownership", async () => {
    const h = await harness();
    const slot = await h.register();
    const object = inspectAsset(slot, png);
    const input = { expectedVersion: 2, assetId: slot.assetId, object };
    for (const identity of [
      fixtureAuth("author_1"),
      { ...fixtureAuth("author_1"), roles: [uploadVerifierIdentity.role] },
      { ...service(uploadVerifierIdentity), mode: "external" as const },
    ])
      expect(await h.run("completeUpload", input, identity)).toMatchObject({
        ok: false,
        error: { code: "auth.forbidden" },
      });
    expect(
      await h.run(
        "completeUpload",
        {
          ...input,
          object: {
            ...object,
            contentId: otherId,
            objectKey: `assets/${otherId}/${slot.assetId}/original`,
          },
        },
        service(uploadVerifierIdentity),
      ),
    ).toMatchObject({ ok: false, error: { code: "command.rejected" } });
    for (const expectedSize of [0, limits.assetBytes + 1, 1.5])
      expect(
        await h.run("registerAsset", {
          expectedVersion: 2,
          filename: "x.png",
          mediaType: "image/png",
          expectedSize,
        }),
      ).toMatchObject({ ok: false, error: { code: "command.validation" } });
    await expect(h.send(slot, png, fixtureAuth("author_2"))).rejects.toMatchObject({
      code: "auth.forbidden",
    });
    expect(
      await h.run("removeAsset", { expectedVersion: 2, assetId: slot.assetId }, "author_2"),
    ).toMatchObject({ ok: false, error: { code: "auth.forbidden" } });
    expect(await h.run("removeAsset", { expectedVersion: 2, assetId: otherId })).toMatchObject({
      ok: false,
      error: { code: "command.rejected" },
    });
  });

  it("validates stored slot ownership, source versions and approved reference equality", async () => {
    const h = await harness();
    const slot = await h.register();
    expect(assetSlotSchema.safeParse({ ...slot, objectKey: "assets/../../evil" }).success).toBe(
      false,
    );
    expect(
      contentStateSchema.safeParse({
        ...(await h.current()).state,
        attachments: [
          { ...slot, contentId: otherId, objectKey: `assets/${otherId}/${slot.assetId}/original` },
        ],
      }).success,
    ).toBe(false);
    const state = await h.current();
    h.memory.store.resources.set(`contentItem\0${contentId}`, {
      ...state,
      state: { ...state.state, attachments: [{ ...slot, sourceVersion: state.version + 1 }] },
    });
    expect(
      await h.run("editDraft", { expectedVersion: state.version, title: "Edit", body: "Body" }),
    ).toMatchObject({ ok: false, error: { code: "resource.invalid_state" } });
  });
});

describe("bounded upload service", () => {
  it("keeps cross-content IDs and forged uploader privileges away from the byte stream", async () => {
    const h = await harness();
    const slot = await h.register();
    expect((await h.run("create", { title: "Other", body: "Body" }, "author_1", otherId)).ok).toBe(
      true,
    );
    let consumed = false;
    const body = () =>
      (async function* () {
        consumed = true;
        yield png;
      })();
    await expect(
      h.upload({
        contentId: otherId,
        assetId: slot.assetId,
        identity: fixtureAuth("author_1"),
        body: body(),
      }),
    ).rejects.toMatchObject({ code: "command.rejected" });
    await expect(
      h.upload({
        contentId,
        assetId: slot.assetId,
        identity: { ...fixtureAuth("author_2"), roles: ["author", "editor"] },
        body: body(),
      }),
    ).rejects.toMatchObject({ code: "auth.forbidden" });
    expect(consumed).toBe(false);
  });

  it("enforces a stream deadline, releases its permit, and bounds completion retries", async () => {
    const h = await harness();
    const slot = await h.register();
    const upload = createUploadService({
      repository: h.memory.repository,
      dispatch: h.dispatch,
      objects: h.objects,
      clock: h.clock,
      timeoutMs: 5,
    });
    const slow = (async function* () {
      await delay(25);
      yield png;
    })();
    await expect(
      upload({ contentId, assetId: slot.assetId, body: slow, identity: fixtureAuth("author_1") }),
    ).rejects.toMatchObject({ code: "runtime.unavailable" });
    const blocked = (async function* () {
      await new Promise<void>(() => {});
      yield png;
    })();
    await expect(
      upload({
        contentId,
        assetId: slot.assetId,
        body: blocked,
        identity: fixtureAuth("author_1"),
      }),
    ).rejects.toMatchObject({ code: "runtime.unavailable" });
    let attempts = 0;
    const conflict = createUploadService({
      repository: h.memory.repository,
      objects: h.objects,
      clock: h.clock,
      dispatch: async () => {
        attempts++;
        return {
          ok: false,
          error: { code: "resource.conflict", message: "Injected conflict" },
          meta: { requestId: "test", correlationId: "test" },
        };
      },
    });
    await expect(
      conflict({ contentId, assetId: slot.assetId, body: png, identity: fixtureAuth("author_1") }),
    ).rejects.toMatchObject({ code: "resource.conflict" });
    expect(attempts).toBe(3);
    expect((await h.current()).state.attachments[0]?.status).toBe("pending");
    expect((await h.send(slot)).status).toBe("ready");
  });

  it("does not report an old ready slot after removal wins during readback", async () => {
    const h = await harness();
    const slot = await h.register();
    await h.send(slot);
    const upload = createUploadService({
      repository: h.memory.repository,
      dispatch: h.dispatch,
      clock: h.clock,
      objects: {
        ...h.objects,
        read: async (reference) => {
          const bytes = await h.objects.read(reference);
          expect(
            (await h.run("removeAsset", { expectedVersion: 3, assetId: slot.assetId })).ok,
          ).toBe(true);
          return bytes;
        },
      },
    });
    await expect(
      upload({ contentId, assetId: slot.assetId, body: png, identity: fixtureAuth("author_1") }),
    ).rejects.toMatchObject({ code: "command.rejected" });
    expect((await h.current()).state.attachments[0]?.status).toBe("removed");
  });

  it("lets only one complete/remove command win the same content version", async () => {
    const h = await harness();
    const slot = await h.register();
    const object = inspectAsset(slot, png);
    const results = await Promise.all([
      h.run(
        "completeUpload",
        { expectedVersion: 2, assetId: slot.assetId, object },
        service(uploadVerifierIdentity),
      ),
      h.run("removeAsset", { expectedVersion: 2, assetId: slot.assetId }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toMatchObject([{ error: { code: "resource.conflict" } }]);
    expect((await h.current()).version).toBe(3);
  });

  it("retries after object creation and a failed completion without overwriting or trusting a checksum", async () => {
    const h = await harness();
    const slot = await h.register();
    let fail = true;
    const dispatch: typeof h.dispatch = async (request, identity) => {
      if (fail) {
        fail = false;
        return {
          ok: false,
          error: { code: "runtime.unavailable", message: "Injected interrupted completion" },
          meta: { requestId: "test", correlationId: "test" },
        };
      }
      return h.dispatch(request, identity);
    };
    const upload = createUploadService({
      repository: h.memory.repository,
      dispatch,
      objects: h.objects,
      clock: h.clock,
    });
    const request = {
      contentId,
      assetId: slot.assetId,
      body: png,
      identity: fixtureAuth("author_1"),
    };
    await expect(upload(request)).rejects.toMatchObject({ code: "runtime.unavailable" });
    expect((await h.current()).state.attachments[0]?.status).toBe("pending");
    expect(Buffer.from(await h.objects.read(inspectAsset(slot, png)))).toEqual(png);
    const different = Buffer.from(png);
    different[different.length - 1] = different[different.length - 1]! ^ 1;
    await expect(upload({ ...request, body: different })).rejects.toMatchObject({
      code: "resource.conflict",
    });
    expect((await upload(request)).status).toBe("ready");
  });

  it("rechecks removal after streaming and after the object write, leaving only a safe orphan", async () => {
    for (const point of ["stream", "object"] as const) {
      const h = await harness();
      const slot = await h.register();
      const retire = async () => {
        expect(
          (
            await h.run("removeAsset", {
              expectedVersion: (await h.current()).version,
              assetId: slot.assetId,
            })
          ).ok,
        ).toBe(true);
      };
      const objects = {
        ...h.objects,
        create: vi.fn(async (target, bytes) => {
          const ref = await h.objects.create(target, bytes);
          await retire();
          return ref;
        }),
      };
      const upload = createUploadService({
        repository: h.memory.repository,
        dispatch: h.dispatch,
        objects,
        clock: h.clock,
      });
      const body =
        point === "stream"
          ? (async function* () {
              yield png.subarray(0, 8);
              await retire();
              yield png.subarray(8);
            })()
          : png;
      await expect(
        upload({ contentId, assetId: slot.assetId, body, identity: fixtureAuth("author_1") }),
      ).rejects.toMatchObject({ code: "command.rejected" });
      expect((await h.current()).state.attachments[0]?.status).toBe("removed");
      expect(objects.create).toHaveBeenCalledTimes(point === "stream" ? 0 : 1);
      if (point === "object")
        expect(Buffer.from(await h.objects.read(inspectAsset(slot, png)))).toEqual(png);
    }
  });

  it("retries a completion version conflict after an unrelated edit, but not after removal", async () => {
    for (const mutation of ["editDraft", "removeAsset"] as const) {
      const h = await harness();
      const slot = await h.register();
      let once = true;
      const upload = createUploadService({
        repository: h.memory.repository,
        objects: h.objects,
        clock: h.clock,
        dispatch: async (request, identity) => {
          if (once) {
            once = false;
            expect(
              (
                await h.run(
                  mutation,
                  mutation === "editDraft"
                    ? { expectedVersion: 2, title: "Edited during upload", body: "Body" }
                    : { expectedVersion: 2, assetId: slot.assetId },
                )
              ).ok,
            ).toBe(true);
          }
          return h.dispatch(request, identity);
        },
      });
      const promise = upload({
        contentId,
        assetId: slot.assetId,
        body: png,
        identity: fixtureAuth("author_1"),
      });
      if (mutation === "editDraft") {
        expect((await promise).status).toBe("ready");
        expect((await h.current()).state.title).toBe("Edited during upload");
      } else {
        await expect(promise).rejects.toMatchObject({ code: "command.rejected" });
        expect((await h.current()).state.attachments[0]?.status).toBe("removed");
      }
    }
  });

  it("bounds two concurrent streams, then admits more after they complete", async () => {
    const h = await harness();
    const slot = await h.register();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = () =>
      (async function* () {
        await gate;
        yield png;
      })();
    const first = h.upload({
      contentId,
      assetId: slot.assetId,
      body: body(),
      identity: fixtureAuth("author_1"),
    });
    const second = h.upload({
      contentId,
      assetId: slot.assetId,
      body: body(),
      identity: fixtureAuth("editor_1"),
    });
    await expect(h.send(slot)).rejects.toMatchObject({ code: "runtime.unavailable" });
    release();
    expect((await Promise.all([first, second])).every((slot) => slot.status === "ready")).toBe(
      true,
    );
    expect((await h.send(slot)).status).toBe("ready");
    expect(
      h.memory.store.outbox.filter((event) => event.eventType === "contentItem.assetReady"),
    ).toHaveLength(1);
  });

  it("rejects interrupted, oversized, wrong-type and timed-out streams without a ready slot", async () => {
    const h = await harness();
    const slot = await h.register();
    const broken = (async function* () {
      yield png.subarray(0, 8);
      throw new Error("sensitive transport details");
    })();
    await expect(
      h.upload({
        contentId,
        assetId: slot.assetId,
        body: broken,
        identity: fixtureAuth("author_1"),
      }),
    ).rejects.toMatchObject({
      code: "runtime.unavailable",
      message: "Upload interrupted; retry the same bytes.",
    });
    await expect(h.send(slot, Buffer.concat([png, Buffer.from("extra")]))).rejects.toMatchObject({
      code: "command.validation",
    });
    await expect(h.send(slot, Buffer.alloc(png.length))).rejects.toMatchObject({
      code: "command.validation",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      h.upload({
        contentId,
        assetId: slot.assetId,
        body: png,
        identity: fixtureAuth("author_1"),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "runtime.unavailable" });
    expect((await h.current()).state.attachments[0]?.status).toBe("pending");
  });

  it("does not submit a pending slot when upload completion races submission", async () => {
    const h = await harness();
    const slot = await h.register();
    const results = await Promise.all([
      h.send(slot),
      h.run("submit", {
        expectedVersion: 2,
        assignedEditorId: "editor_1",
        dueAt: "2026-11-01T12:00:00.000Z",
      }),
    ]);
    expect(results[0].status).toBe("ready");
    expect(results[1]).toMatchObject({ ok: false });
    expect((await h.current()).state.status).toBe("draft");
  });
});

describe("asset materialization primitives", () => {
  it("materializes ready then removed facts but never rewrites verified or terminal metadata", async () => {
    const h = await harness();
    const slot = await h.register();
    const ready = await h.send(slot);
    const internal = service(assetProjectorIdentity);
    expect(
      (await h.run("createSnapshot", { snapshot: slot }, internal, slot.assetId, "asset")).ok,
    ).toBe(true);
    expect(
      (
        await h.run(
          "applySnapshot",
          { expectedVersion: 1, snapshot: ready },
          internal,
          slot.assetId,
          "asset",
        )
      ).ok,
    ).toBe(true);
    const forged = {
      ...ready,
      sourceVersion: ready.sourceVersion + 1,
      verified: { ...ready.verified!, sha256: "0".repeat(64) },
    };
    expect(
      await h.run(
        "applySnapshot",
        { expectedVersion: 2, snapshot: forged },
        internal,
        slot.assetId,
        "asset",
      ),
    ).toMatchObject({ ok: false, error: { code: "command.rejected" } });
    expect((await h.run("removeAsset", { expectedVersion: 3, assetId: slot.assetId })).ok).toBe(
      true,
    );
    const removed = (await h.current()).state.attachments[0]!;
    expect(
      (
        await h.run(
          "applySnapshot",
          { expectedVersion: 2, snapshot: removed },
          internal,
          slot.assetId,
          "asset",
        )
      ).ok,
    ).toBe(true);
    expect(
      await h.run(
        "applySnapshot",
        {
          expectedVersion: 3,
          snapshot: {
            ...forged,
            status: "removed",
            retiredAt: removed.retiredAt,
            sourceVersion: removed.sourceVersion + 1,
          },
        },
        internal,
        slot.assetId,
        "asset",
      ),
    ).toMatchObject({ ok: false, error: { code: "command.rejected" } });
    expect(await h.run("approve", {}, "editor_1", slot.assetId, "asset")).toMatchObject({
      ok: false,
      error: { code: "command.rejected" },
    });
  });

  it("accepts complete out-of-order tombstones, never revives them, and does not grant editorial authority", async () => {
    const h = await harness();
    const slot = await h.register();
    await h.send(slot);
    expect((await h.run("removeAsset", { expectedVersion: 3, assetId: slot.assetId })).ok).toBe(
      true,
    );
    const removed = (await h.current()).state.attachments[0]!;
    expect(
      await h.run("createSnapshot", { snapshot: removed }, "author_1", slot.assetId, "asset"),
    ).toMatchObject({ ok: false, error: { code: "auth.forbidden" } });
    expect(
      (
        await h.run(
          "createSnapshot",
          { snapshot: removed },
          service(assetProjectorIdentity),
          slot.assetId,
          "asset",
        )
      ).ok,
    ).toBe(true);
    for (const snapshot of [
      slot,
      { ...slot, sourceVersion: removed.sourceVersion + 1 },
      { ...removed, filename: "rewrite.png", sourceVersion: removed.sourceVersion + 1 },
    ])
      expect(
        await h.run(
          "applySnapshot",
          { expectedVersion: 1, snapshot },
          service(assetProjectorIdentity),
          slot.assetId,
          "asset",
        ),
      ).toMatchObject({ ok: false, error: { code: "command.rejected" } });
    expect(await h.memory.repository.listProjection(`asset.content.${contentId}`)).toMatchObject([
      { data: { status: "removed" } },
    ]);
    expect(assetUi.commands).toEqual({});
    expect(h.memory.store.outbox.at(-1)?.eventType).toBe("asset.snapshotApplied");
  });
});
