import { randomUUID } from "node:crypto";
import { createFixtureClock, createMemoryRuntime } from "../../src/application/runtime";
import { createPublisher, type PublicationFaultPoint } from "../../src/application/publisher";
import type { PublicationObjectStore } from "../../src/application/publication-artifact";
import { parseContentEvent } from "../../src/shared/events";
import { fixtureAuth } from "../../src/shared/identities";
import type { ContentState } from "../../src/shared/contracts";

export async function publicationHarness() {
  const contentId = randomUUID();
  const clock = createFixtureClock("2026-10-31T12:00:00.000Z");
  const app = createMemoryRuntime({ clock: clock.now });
  let sequence = 0;
  const run = (commandName: string, input: unknown, editor = true) =>
    app.dispatch(
      {
        resourceType: "contentItem",
        resourceId: contentId,
        commandName,
        input,
        idempotencyKey: `publisher-test:${++sequence}`,
        requestContext: {},
      },
      fixtureAuth(editor ? "editor_1" : "author_1"),
    );
  const current = async () =>
    (await app.persistence.repository.getState<ContentState>("contentItem", contentId))!;
  const check = (result: { ok: boolean }) => {
    if (!result.ok) throw new Error("Publisher fixture setup failed.");
  };
  check(await run("create", { title: "Stable publication", body: "Frozen body" }, false));
  check(
    await run(
      "submit",
      { expectedVersion: 1, assignedEditorId: "editor_1", dueAt: "2026-11-01T12:00:00.000Z" },
      false,
    ),
  );
  const submitted = await current();
  check(
    await run("approve", {
      expectedVersion: submitted.version,
      reviewId: submitted.state.review!.reviewId,
      revisionId: submitted.state.revisionId,
      note: "Approved",
    }),
  );
  const approved = await current();
  check(
    await run("publishNow", {
      expectedVersion: approved.version,
      reviewId: approved.state.approval!.reviewId,
      revisionId: approved.state.revisionId,
    }),
  );
  const event = () =>
    parseContentEvent(
      [...app.persistence.store.outbox]
        .reverse()
        .find(
          (e) =>
            e.eventType === "contentItem.publicationRequested" ||
            e.eventType === "contentItem.publicationRetried",
        )!,
    );
  const publisher = (
    options: {
      objects?: PublicationObjectStore;
      fault?: (point: PublicationFaultPoint) => void | Promise<void>;
    } = {},
  ) =>
    createPublisher({
      repository: app.persistence.repository,
      dispatch: app.dispatch,
      objects: options.objects ?? app.objects,
      clock: clock.now,
      ...(options.fault ? { fault: options.fault } : {}),
    });
  return {
    app,
    clock,
    run,
    current,
    event,
    publisher,
    contentId,
    intent: (await current()).state.publication!.intent,
  };
}
