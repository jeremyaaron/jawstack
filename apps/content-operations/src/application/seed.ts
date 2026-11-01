import { JawStackRuntimeError } from "@jawstack/core";
import type { ContentState } from "../shared/contracts";
import { fixtureAuth } from "../shared/identities";
import type { ApiRuntime } from "./api-runtime";

export const seedItems = [
  "draft",
  "review",
  "changesRequested",
  "approved",
  "scheduled",
  "published",
].map((stage, index) => ({
  id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  stage,
}));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1kAAAAASUVORK5CYII=",
  "base64",
);
export function createSeeder(runtime: ApiRuntime) {
  let tail = Promise.resolve();
  return async () => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const created: string[] = [];
      const skipped: string[] = [];
      for (const item of seedItems) {
        if (await runtime.repository.getState("contentItem", item.id)) {
          skipped.push(item.id);
          continue;
        }
        const current = async () =>
          (await runtime.repository.getState("contentItem", item.id))! as {
            version: number;
            state: ContentState;
          };
        let step = 0;
        const run = async (commandName: string, input: unknown, editor = false) => {
          const result = await runtime.dispatch(
            {
              resourceType: "contentItem",
              resourceId: item.id,
              commandName,
              input,
              idempotencyKey: `seed:v1:${item.id}:${++step}`,
              requestContext: {},
            },
            fixtureAuth(editor ? "editor_1" : "author_1"),
          );
          if (!result.ok)
            throw new JawStackRuntimeError(
              result.error.code,
              "Seed command did not complete; existing items were retained.",
            );
        };
        await run("create", {
          title: `Release notes: ${item.stage}`,
          body: "A maintained editorial reference item.\nChanges remain under normal versioned commands.",
        });
        if (item.stage === "published") {
          await run("registerAsset", {
            expectedVersion: (await current()).version,
            filename: "proof.png",
            mediaType: "image/png",
            expectedSize: png.length,
          });
          const slot = (await current()).state.attachments[0]!;
          await runtime.upload({
            contentId: item.id,
            assetId: slot.assetId,
            identity: fixtureAuth("author_1"),
            body: png,
          });
        }
        if (item.stage !== "draft") {
          await run("submit", {
            expectedVersion: (await current()).version,
            assignedEditorId: "editor_1",
            dueAt: new Date(runtime.clock().getTime() + 86_400_000).toISOString(),
          });
          if (item.stage !== "review") {
            const row = await current();
            await run(
              item.stage === "changesRequested" ? "requestChanges" : "approve",
              {
                expectedVersion: row.version,
                reviewId: row.state.review!.reviewId,
                revisionId: row.state.revisionId,
                note:
                  item.stage === "changesRequested"
                    ? "Clarify the release summary."
                    : "Approved for publication.",
              },
              true,
            );
          }
          if (item.stage === "scheduled" || item.stage === "published") {
            const row = await current();
            await run(
              item.stage === "scheduled" ? "schedule" : "publishNow",
              {
                expectedVersion: row.version,
                reviewId: row.state.approval!.reviewId,
                revisionId: row.state.revisionId,
                ...(item.stage === "scheduled"
                  ? {
                      scheduledAt: new Date(runtime.clock().getTime() + 3_600_000).toISOString(),
                      timeZone: "UTC",
                    }
                  : {}),
              },
              true,
            );
          }
        }
        created.push(item.id);
        await runtime.process?.();
      }
      return { created, skipped };
    } finally {
      release();
    }
  };
}
