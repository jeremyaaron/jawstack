import "@angular/compiler";
import { describe, expect, it, vi } from "vitest";
import { JawStackApiError } from "@jawstack/angular";
import { ContentOperationsClient, type ContentResource } from "../../src/web/client";
import { DraftEditor } from "../../src/web/draft-editor";
import { createMemoryApiRuntime } from "../../src/application/api-runtime";
import { publicValue } from "../../src/shared/api";
import { fixtureAuth, type FixtureId } from "../../src/shared/identities";

async function fixture() {
  const runtime = createMemoryApiRuntime();
  const command = await runtime.dispatch(
    {
      resourceType: "contentItem",
      commandName: "create",
      input: { title: "Original", body: "Original body" },
      idempotencyKey: "unit-editor-create",
      requestContext: {},
    },
    fixtureAuth("author_1"),
  );
  if (!command.ok) throw new Error("Fixture failed");
  const row = publicValue(
    await runtime.repository.getState(
      "contentItem",
      (command.data as { resourceId: string }).resourceId,
    ),
  ) as ContentResource;
  let actor: FixtureId = "author_1";
  const client = new ContentOperationsClient({ fixture: () => actor });
  const editor = new DraftEditor(client, () => actor);
  editor.accept(row);
  return {
    editor,
    client,
    row,
    actor: (next: FixtureId) => {
      actor = next;
    },
  };
}
describe("version-aware draft editor", () => {
  it("retains one intent for ambiguous retries, rejects duplicate submission, resets keys for changed input", async () => {
    const h = await fixture();
    h.editor.form.controls.title.setValue("Local");
    let reject!: (error: Error) => void;
    const mutate = vi.spyOn(h.client, "mutate").mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const first = h.editor.save();
    await h.editor.save();
    expect(mutate).toHaveBeenCalledTimes(1);
    reject(new TypeError("response lost"));
    await first;
    mutate.mockRejectedValue(new TypeError("offline"));
    await h.editor.save();
    expect(mutate.mock.calls[0]![3]).toBe(mutate.mock.calls[1]![3]);
    expect(h.editor.form.controls.title.value).toBe("Local");
    expect(h.editor.dirty()).toBe(true);
    h.editor.form.controls.title.setValue("Different");
    await h.editor.save();
    expect(mutate.mock.calls[2]![3]).not.toBe(mutate.mock.calls[0]![3]);
    h.editor.destroy();
  });
  it("preserves local text on conflict and only adopts a new base after explicit comparison", async () => {
    const h = await fixture();
    h.editor.form.setValue({ title: "Local", body: "Local body" });
    const mutate = vi
      .spyOn(h.client, "mutate")
      .mockRejectedValue(
        new JawStackApiError("Conflict", { status: 409, code: "resource.conflict" }),
      );
    await h.editor.save();
    expect(h.editor.conflict()).toBe(true);
    await h.editor.save();
    expect(mutate).toHaveBeenCalledTimes(1);
    const latest = {
      ...h.row,
      version: 2,
      state: { ...h.row.state, title: "Server", body: "Server body" },
    };
    vi.spyOn(h.client, "getContent").mockResolvedValue(latest);
    await h.editor.compare();
    expect(h.editor.resource()!.version).toBe(1);
    expect(h.editor.form.controls.body.value).toBe("Local body");
    h.editor.keepLocal();
    expect(h.editor.resource()!.version).toBe(2);
    expect(h.editor.dirty()).toBe(true);
    mutate.mockResolvedValue({ resourceId: h.row.resourceId, version: 3 });
    await h.editor.save();
    expect(mutate.mock.calls[1]![1]).toMatchObject({
      expectedVersion: 2,
      title: "Local",
      body: "Local body",
    });
    h.editor.destroy();
  });
  it("validates shared text bounds, owner permissions, server adoption and byte-preserving saves", async () => {
    const h = await fixture();
    const mutate = vi.spyOn(h.client, "mutate");
    h.editor.form.controls.title.setValue("   ");
    await h.editor.save();
    expect(h.editor.validation()).toContain("title");
    h.editor.form.setValue({ title: "Title", body: "é".repeat(16385) });
    await h.editor.save();
    expect(h.editor.validation()).toContain("32 KiB");
    expect(mutate).not.toHaveBeenCalled();
    h.actor("author_2");
    expect(h.editor.editable()).toBe(false);
    await h.editor.save();
    expect(mutate).not.toHaveBeenCalled();
    h.actor("editor_1");
    expect(h.editor.editable()).toBe(true);
    h.editor.latest.set(h.row);
    h.editor.useServer();
    expect(h.editor.dirty()).toBe(false);
    expect(h.editor.form.controls.title.value).toBe("Original");
    h.editor.form.setValue({ title: " Trimmed ", body: " Body\n " });
    mutate.mockResolvedValue({ resourceId: h.row.resourceId, version: 2 });
    vi.spyOn(h.client, "getContent").mockRejectedValue(new TypeError("read interrupted"));
    expect(await h.editor.save()).toBe(h.row.resourceId);
    expect(h.editor.dirty()).toBe(false);
    expect(h.editor.form.getRawValue()).toEqual({ title: "Trimmed", body: " Body\n " });
    expect(h.editor.resource()!.version).toBe(2);
    h.editor.destroy();
  });
});
