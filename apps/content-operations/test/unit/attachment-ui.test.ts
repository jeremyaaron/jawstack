import "@angular/compiler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryApiRuntime } from "../../src/application/api-runtime";
import { startContentApi } from "../../src/http/server";
import { ContentOperationsClient } from "../../src/web/client";
import { AttachmentSession } from "../../src/web/attachment-session";
import { png } from "../support/editorial";
import type { FixtureId } from "../../src/shared/identities";

const apis: Awaited<ReturnType<typeof startContentApi>>[] = [];
afterEach(async () => {
  await Promise.all(apis.splice(0).map((api) => api.close()));
  vi.restoreAllMocks();
});
async function setup() {
  const runtime = createMemoryApiRuntime();
  const api = await startContentApi({ runtime, port: 0, managed: false });
  apis.push(api);
  let actor: FixtureId = "author_1";
  const client = new ContentOperationsClient({ fixture: () => actor, base: `${api.baseUrl}/api` });
  const created = await client.mutate("create", {
    title: "Media proof",
    body: "Frozen plain text",
  });
  let row = await client.getContent(created.resourceId);
  let blocked = false;
  const session = new AttachmentSession(
    client,
    () => actor,
    () => row,
    (next) => {
      row = next;
    },
    () => blocked,
  );
  // This harness exercises the actual HTTP upload/verification path; XHR events are tested separately.
  vi.spyOn(client, "upload").mockImplementation(
    async (contentId, assetId, file, signal, progress) => {
      progress(100);
      return client.request(`/uploads/${contentId}/${assetId}`, {
        method: "PUT",
        body: file,
        headers: { "content-type": file.type },
        signal,
      });
    },
  );
  return {
    runtime,
    client,
    session,
    row: () => row,
    adopt: async () => {
      row = await client.getContent(row.resourceId);
    },
    block: (next: boolean) => {
      blocked = next;
    },
    actor: (next: FixtureId) => {
      actor = next;
    },
  };
}
const file = () => new File([png], "proof.png", { type: "image/png" });
describe("HTTP-backed attachment workflow", () => {
  it("cancels in-flight transfers without treating 100 percent transferred as ready", async () => {
    const h = await setup();
    const selected = file();
    vi.mocked(h.client.upload).mockImplementationOnce(
      async (_content, _asset, _file, signal, progress) => {
        progress(100);
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          ),
        );
        throw new Error("Unreachable");
      },
    );
    h.session.select(selected);
    const pending = h.session.upload();
    await vi.waitFor(() => expect(h.session.transferring()).toBe(true));
    expect(h.session.progress()).toBe(100);
    expect(h.row().state.attachments[0]!.status).toBe("pending");
    await h.session.upload();
    expect(h.client.upload).toHaveBeenCalledTimes(1);
    h.session.cancel();
    await pending;
    expect(h.session.pending()).toBe(false);
    expect(h.session.file()).toBe(selected);
    expect(h.session.error()).toContain("did not complete");
    expect(h.row().state.attachments[0]!.verified).toBeNull();
    h.session.destroy();
  });
  it("rejects malicious names, empty, unsupported and oversized files before any registration", async () => {
    const h = await setup();
    const mutate = vi.spyOn(h.client, "mutate");
    for (const invalid of [
      new File([png], '<img onerror="alert(1)">.png', { type: "image/png" }),
      new File([png], "a\u202e.png", { type: "image/png" }),
      new File([], "empty.pdf", { type: "application/pdf" }),
      new File([png], "code.html", { type: "text/html" }),
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }),
    ]) {
      h.session.select(invalid);
      expect(h.session.file()).toBeUndefined();
      expect(h.session.error()).toContain("safe filename");
    }
    expect(mutate).not.toHaveBeenCalled();
    expect(h.row().version).toBe(1);
    h.session.destroy();
  });
  it("preserves file and registration key across lost responses and retries the same pending slot", async () => {
    const h = await setup();
    const selected = file();
    const original = h.client.mutate.bind(h.client);
    let lost = true;
    const mutation = vi
      .spyOn(h.client, "mutate")
      .mockImplementation(async (name, input, id, key) => {
        const result = await original(name, input, id, key);
        if (lost) {
          lost = false;
          throw new TypeError("Response lost after commit");
        }
        return result;
      });
    h.session.select(selected);
    await h.session.upload();
    expect(h.session.file()).toBe(selected);
    expect(h.session.target()).toBeUndefined();
    expect((await h.client.getContent(h.row().resourceId)).state.attachments[0]!.status).toBe(
      "pending",
    );
    vi.mocked(h.client.upload).mockRejectedValueOnce(new TypeError("Transfer interrupted"));
    await h.session.upload();
    expect(mutation.mock.calls[0]![3]).toBe(mutation.mock.calls[1]![3]);
    expect(h.session.file()).toBe(selected);
    expect(h.row().state.attachments[0]!.status).toBe("pending");
    await h.session.upload();
    expect(h.session.file()).toBeUndefined();
    expect(h.row().state.attachments).toHaveLength(1);
    const slot = h.row().state.attachments[0]!;
    expect(slot.status).toBe("ready");
    expect(h.row().version).toBe(3);
    const reference = { ...slot, size: slot.verified!.size, sha256: slot.verified!.sha256 };
    const blob = await h.client.attachment(reference);
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(png);
    await expect(h.client.attachment({ ...reference, sha256: "0".repeat(64) })).rejects.toThrow(
      "verified reference",
    );
    await h.session.remove(slot);
    expect(h.row().state.attachments[0]!.status).toBe("removed");
    // Historical verified bytes remain downloadable, without trusting an asset projection.
    expect((await h.client.attachment(reference)).size).toBe(png.length);
    h.session.destroy();
  });
  it("never marks rejected signatures ready and retains selected bytes/version on conflict", async () => {
    const h = await setup();
    h.session.select(new File(["not png bytes"], "proof.png", { type: "image/png" }));
    await h.session.upload();
    expect(h.session.error()).toContain("Upload rejected");
    expect(h.row().state.attachments[0]!.status).toBe("pending");
    h.session.reset();
    const selected = file();
    h.session.select(selected);
    const row = h.row();
    await h.client.mutate(
      "editDraft",
      { expectedVersion: row.version, title: "Concurrent text", body: "Not overwritten" },
      row.resourceId,
    );
    await h.session.upload();
    expect(h.session.conflict()).toBe(true);
    expect(h.session.file()).toBe(selected);
    expect(h.row().version).toBe(row.version);
    expect((await h.client.getContent(row.resourceId)).state.body).toBe("Not overwritten");
    h.session.destroy();
  });
  it("blocks dirty and foreign draft operations and only exposes the committed published artifact", async () => {
    const h = await setup();
    h.session.select(file());
    h.block(true);
    await h.session.upload();
    expect(h.row().version).toBe(1);
    h.block(false);
    await h.session.upload();
    const slot = h.row().state.attachments[0]!;
    const id = h.row().resourceId;
    await h.client.mutate(
      "submit",
      {
        expectedVersion: h.row().version,
        assignedEditorId: "editor_1",
        dueAt: new Date(Date.now() + 86400000).toISOString(),
      },
      id,
    );
    h.actor("editor_1");
    await h.adopt();
    const review = h.row().state.review!;
    await h.client.mutate(
      "approve",
      {
        expectedVersion: h.row().version,
        reviewId: review.reviewId,
        revisionId: review.submitted.revisionId,
        note: "Approved proof",
      },
      id,
    );
    await h.adopt();
    await expect(h.client.publication(id)).rejects.toMatchObject({ status: 404 });
    await h.client.mutate(
      "publishNow",
      {
        expectedVersion: h.row().version,
        reviewId: review.reviewId,
        revisionId: review.submitted.revisionId,
      },
      id,
    );
    await expect(h.client.publication(id)).rejects.toMatchObject({ status: 404 });
    await h.runtime.app.drainUntilIdle();
    await h.adopt();
    expect(h.row().state.status).toBe("published");
    const view = await h.client.publication(id);
    expect(view.artifact.content.body).toBe("Frozen plain text");
    expect(view.artifact.content.attachments[0]!.assetId).toBe(slot.assetId);
    expect(JSON.stringify(view)).not.toMatch(/objectKey|fencingToken/);
    expect((await h.client.attachment(view.artifact.content.attachments[0]!)).size).toBe(
      png.length,
    );
    expect(h.session.editable()).toBe(false);
    await h.session.remove(slot);
    await expect(
      h.client.mutate(
        "removeAsset",
        { expectedVersion: h.row().version, assetId: slot.assetId },
        id,
      ),
    ).rejects.toBeDefined();
    h.session.select(file());
    expect(h.session.file()).toBeUndefined();
    h.session.destroy();
    const other = await setup();
    other.actor("author_2");
    expect(other.session.editable()).toBe(false);
    other.session.select(file());
    expect(other.session.file()).toBeUndefined();
    other.session.destroy();
  });
});
