import { randomUUID } from "node:crypto";
import { createFixtureClock, createMemoryRuntime } from "../../src/application/runtime";
import { fixtureAuth } from "../../src/shared/identities";
import type { ContentState } from "../../src/shared/contracts";

export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1kAAAAASUVORK5CYII=",
  "base64",
);
export function editorialHarness() {
  const clock = createFixtureClock("2026-10-31T12:00:00.000Z");
  const app = createMemoryRuntime({ clock: clock.now });
  let sequence = 0;
  const current = async (id: string) =>
    (await app.persistence.repository.getState<ContentState>("contentItem", id))!;
  const run = (id: string, commandName: string, input: unknown, editor = false) =>
    app.dispatch(
      {
        resourceType: "contentItem",
        resourceId: id,
        commandName,
        input,
        idempotencyKey: `editorial-test:${++sequence}`,
        requestContext: {},
      },
      fixtureAuth(editor ? "editor_1" : "author_1"),
    );
  const check = (result: { ok: boolean }) => {
    if (!result.ok) throw new Error("Editorial fixture setup failed.");
  };
  const create = async (stage: "draft" | "review" | "scheduled" = "draft", hours = 1) => {
    const id = randomUUID();
    check(await run(id, "create", { title: "Due work", body: "Body" }));
    if (stage !== "draft")
      check(
        await run(id, "submit", {
          expectedVersion: 1,
          assignedEditorId: "editor_1",
          dueAt: new Date(clock.now().getTime() + hours * 3_600_000).toISOString(),
        }),
      );
    if (stage === "scheduled") {
      const review = await current(id);
      check(
        await run(
          id,
          "approve",
          {
            expectedVersion: review.version,
            reviewId: review.state.review!.reviewId,
            revisionId: review.state.revisionId,
            note: "Approved",
          },
          true,
        ),
      );
      const approved = await current(id);
      check(
        await run(
          id,
          "schedule",
          {
            expectedVersion: approved.version,
            reviewId: approved.state.approval!.reviewId,
            revisionId: approved.state.revisionId,
            scheduledAt: new Date(clock.now().getTime() + hours * 3_600_000).toISOString(),
            timeZone: "UTC",
          },
          true,
        ),
      );
    }
    return id;
  };
  const register = async (id: string) => {
    check(
      await run(id, "registerAsset", {
        expectedVersion: (await current(id)).version,
        filename: "proof.png",
        mediaType: "image/png",
        expectedSize: png.length,
      }),
    );
    return (await current(id)).state.attachments.at(-1)!;
  };
  return { app, clock, run, current, create, register, check };
}
