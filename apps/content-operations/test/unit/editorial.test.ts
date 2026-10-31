import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInMemoryPersistence,
  createManifest,
  executeCommand,
  TestAuthProvider,
  type AuthContext,
  type CommandCommitInput,
} from "@jawstack/core";
import {
  createContentOperationsResources,
  reviewProjectorIdentity,
} from "../../src/domain/resources";
import { contentProjectionPlan } from "../../src/domain/projections";
import {
  contentEventSchemas,
  contentStateSchema,
  contentStatuses,
  jsonBytes,
  limits,
  reviewTaskStateSchema,
  type ContentState,
  type ReviewTaskState,
} from "../../src/shared/contracts";
import { fixtureAuth, fixtureIdentities, type FixtureId } from "../../src/shared/identities";
import { contentUi, reviewUi } from "../../src/shared/presentation";

const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const contentId = uuid(1);
const now = "2026-10-31T12:00:00.000Z";
const dueAt = "2026-11-01T12:00:00.000Z";
const service: AuthContext = {
  subject: reviewProjectorIdentity.subject,
  roles: [reviewProjectorIdentity.role],
  claims: {},
  mode: "test",
};

function harness(newId?: () => string) {
  const memory = createInMemoryPersistence();
  let ids = 10;
  let envelopeIds = 0;
  const resources = createContentOperationsResources({ newId: newId ?? (() => uuid(++ids)) });
  const run = (
    commandName: string,
    input: unknown,
    identity: FixtureId | AuthContext = "author_1",
    resourceId = contentId,
    resourceType = "contentItem",
  ) =>
    executeCommand(
      { resourceType, resourceId, commandName, input, requestContext: {} },
      {
        registry: resources,
        repository: memory.repository,
        unitOfWork: memory.unitOfWork,
        authProvider: new TestAuthProvider(
          typeof identity === "string" ? fixtureAuth(identity) : identity,
        ),
        clock: () => new Date(now),
        source: "content-operations.test",
        ids: {
          resourceId: () => contentId,
          requestId: () => `req_${++envelopeIds}`,
          correlationId: () => `corr_${++envelopeIds}`,
          eventId: () => `evt_${++envelopeIds}`,
          activityId: () => `act_${++envelopeIds}`,
        },
      },
    );
  const current = async () =>
    (await memory.repository.getState<ContentState>("contentItem", contentId))!;
  const create = async (
    title = "Draft title",
    body = "Draft body",
    identity: FixtureId = "author_1",
  ) => {
    expect((await run("create", { title, body }, identity)).ok).toBe(true);
    return current();
  };
  const submit = async () => {
    const previous = await current();
    expect(
      (
        await run("submit", {
          expectedVersion: previous.version,
          assignedEditorId: "editor_1",
          dueAt,
        })
      ).ok,
    ).toBe(true);
    return current();
  };
  const decisionInput = async () => {
    const previous = await current();
    return {
      expectedVersion: previous.version,
      reviewId: previous.state.review?.reviewId ?? uuid(999),
      revisionId: previous.state.revisionId,
      note: "Reviewed",
    };
  };
  const approve = async () => {
    expect((await run("approve", await decisionInput(), "editor_1")).ok).toBe(true);
    return current();
  };
  const snapshot = () =>
    structuredClone({
      resources: memory.store.resources,
      projections: memory.store.projections,
      activity: memory.store.activity,
      outbox: memory.store.outbox,
      idempotency: memory.store.idempotency,
    });
  const rejected = async (
    command: string,
    input: unknown,
    code: string,
    identity: FixtureId | AuthContext = "author_1",
    resourceId = contentId,
    resourceType = "contentItem",
  ) => {
    const before = snapshot();
    expect(await run(command, input, identity, resourceId, resourceType)).toMatchObject({
      ok: false,
      error: { code },
    });
    expect(snapshot()).toEqual(before);
  };
  const seedStatus = async (status: ContentState["status"]) => {
    await create();
    if (["inReview", "approved", "scheduled", "publishing", "published"].includes(status))
      await submit();
    if (["approved", "scheduled", "publishing", "published"].includes(status)) await approve();
    if (status === "archived") {
      expect(
        (await run("archive", { expectedVersion: (await current()).version }, "editor_1")).ok,
      ).toBe(true);
    }
    if (["scheduled", "publishing", "published"].includes(status)) {
      const previous = await current();
      const state = contentStateSchema.parse({
        ...previous.state,
        status,
        schedule:
          status === "scheduled"
            ? { scheduledAt: dueAt, generation: uuid(900), timeZone: "UTC" }
            : null,
      });
      await memory.unitOfWork.commit({
        resource: {
          resourceType: "contentItem",
          resourceId: contentId,
          create: false,
          expectedVersion: previous.version,
          next: { ...previous, version: previous.version + 1, state },
        },
        activity: [],
        outbox: [],
        projections: contentProjectionPlan(previous, state, now),
        response: {},
      });
    }
    return current();
  };
  return {
    ...memory,
    resources,
    run,
    current,
    create,
    submit,
    approve,
    decisionInput,
    rejected,
    snapshot,
    seedStatus,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("editorial content aggregate", () => {
  it("supports generated UUID resource IDs without requiring the caller to choose an ID", async () => {
    const h = harness();
    const result = await executeCommand(
      {
        resourceType: "contentItem",
        commandName: "create",
        input: { title: "Generated ID", body: "Body" },
        requestContext: {},
      },
      {
        registry: h.resources,
        repository: h.repository,
        unitOfWork: h.unitOfWork,
        authProvider: new TestAuthProvider(fixtureAuth("author_1")),
        ids: { resourceId: () => contentId },
        clock: () => new Date(now),
      },
    );
    expect(result).toMatchObject({ ok: true, data: { resourceId: contentId, version: 1 } });
    expect((await h.current()).state.contentId).toBe(contentId);
  });

  it("creates, edits, submits, and approves through public commands without another authority", async () => {
    const h = harness();
    const initial = await h.create();
    expect(initial.state.authorId).toBe("author_1");
    expect(
      (
        await h.run("editDraft", {
          expectedVersion: 1,
          title: "Revised title",
          body: "Revised body",
        })
      ).ok,
    ).toBe(true);
    const edited = await h.current();
    expect(edited.version).toBe(2);
    expect(edited.state.revisionId).not.toBe(initial.state.revisionId);
    const submitted = await h.submit();
    expect(submitted.state.revisionId).toBe(edited.state.revisionId);
    expect(submitted.state.review!.reviewId).not.toBe(edited.state.revisionId);
    expect(submitted.state.review!.sourceVersion).toBe(3);
    expect((await h.run("approve", await h.decisionInput(), "editor_2")).ok).toBe(true);
    const approved = await h.current();
    expect(approved.version).toBe(4);
    expect(approved.state.approval).toMatchObject({
      approvedBy: "editor_2",
      revisionId: edited.state.revisionId,
      reviewId: submitted.state.review!.reviewId,
    });
    expect(
      await h.repository.getState("reviewTask", submitted.state.review!.reviewId),
    ).toBeUndefined();
    for (const event of await h.repository.getOutbox()) {
      expect(
        contentEventSchemas[event.eventType as keyof typeof contentEventSchemas].safeParse(
          event.payload,
        ).success,
      ).toBe(true);
      expect(jsonBytes(event.payload)).toBeLessThanOrEqual(limits.eventBytes);
    }
  });

  const allowed: Record<ContentState["status"], readonly string[]> = {
    draft: ["editDraft", "submit", "archive"],
    inReview: ["approve", "requestChanges", "reopenDraft", "archive"],
    approved: ["reopenDraft", "archive"],
    scheduled: ["reopenDraft", "archive"],
    publishing: [],
    published: ["archive"],
    archived: [],
  };
  for (const status of contentStatuses) {
    it.each(["editDraft", "submit", "approve", "requestChanges", "reopenDraft", "archive"])(
      `enforces ${status} -> %s (reserved execution states are fixture-seeded)`,
      async (command) => {
        const h = harness();
        const previous = await h.seedStatus(status);
        const input =
          command === "editDraft"
            ? { expectedVersion: previous.version, title: "Another title", body: "Another body" }
            : command === "submit"
              ? { expectedVersion: previous.version, assignedEditorId: "editor_1", dueAt }
              : ["approve", "requestChanges"].includes(command)
                ? await h.decisionInput()
                : { expectedVersion: previous.version };
        const before = h.snapshot();
        const result = await h.run(command, input, "editor_1");
        expect(result.ok).toBe(allowed[status].includes(command));
        if (!result.ok) expect(h.snapshot()).toEqual(before);
      },
    );
  }

  it("keeps unchanged-save revisions stable but increments the resource version", async () => {
    const h = harness();
    const first = await h.create();
    expect(
      (
        await h.run("editDraft", {
          expectedVersion: 1,
          title: first.state.title,
          body: first.state.body,
        })
      ).ok,
    ).toBe(true);
    expect((await h.current()).version).toBe(2);
    expect((await h.current()).state.revisionId).toBe(first.state.revisionId);
  });

  it("records changes requested without rewriting the submitted snapshot and generates a fresh next review", async () => {
    const h = harness();
    await h.create();
    const submitted = await h.submit();
    const oldReview = structuredClone(submitted.state.review!);
    expect((await h.run("requestChanges", await h.decisionInput(), "editor_2")).ok).toBe(true);
    expect((await h.current()).state).toMatchObject({
      status: "draft",
      revisionId: oldReview.submitted.revisionId,
      review: { status: "changesRequested", submitted: oldReview.submitted },
    });
    expect(
      (
        await h.run("editDraft", {
          expectedVersion: 3,
          title: "Updated draft",
          body: "Updated body",
        })
      ).ok,
    ).toBe(true);
    const next = await h.submit();
    expect(next.state.review!.reviewId).not.toBe(oldReview.reviewId);
    expect(next.state.review!.submitted.revisionId).not.toBe(oldReview.submitted.revisionId);
    const oldFact = h.store.outbox.find(
      (event) => event.eventType === "contentItem.reviewRequested",
    )!.payload as ReviewTaskState;
    expect(oldFact).toEqual(oldReview);
  });

  it.each(["reopenDraft", "archive"])(
    "emits a complete superseded fact and clears due membership on %s",
    async (command) => {
      const h = harness();
      await h.create();
      const submitted = await h.submit();
      expect(
        (
          await h.run(
            command,
            { expectedVersion: submitted.version },
            command === "archive" ? "editor_1" : "author_1",
          )
        ).ok,
      ).toBe(true);
      const superseded = h.store.outbox.find(
        (event) => event.eventType === "contentItem.reviewSuperseded",
      )!.payload as ReviewTaskState;
      expect(superseded).toMatchObject({
        reviewId: submitted.state.review!.reviewId,
        sourceVersion: 3,
        status: "superseded",
        submitted: submitted.state.review!.submitted,
      });
      expect(await h.repository.listProjection("contentItem.dueReview")).toEqual([]);
      if (command === "archive")
        expect(await h.repository.listProjection("contentItem.list")).toEqual([]);
    },
  );

  it("invalidates approval and scheduled projections on reopen, preserving historical signoff", async () => {
    const h = harness();
    const scheduled = await h.seedStatus("scheduled");
    const historical = structuredClone(scheduled.state.review);
    expect((await h.run("reopenDraft", { expectedVersion: scheduled.version })).ok).toBe(true);
    const reopened = await h.current();
    expect(reopened.state).toMatchObject({
      status: "draft",
      approval: null,
      schedule: null,
      review: historical,
    });
    expect(reopened.state.revisionId).not.toBe(scheduled.state.revisionId);
    expect(await h.repository.listProjection("contentItem.calendar")).toEqual([]);
    expect(await h.repository.listProjection("contentItem.duePublication")).toEqual([]);
  });

  it("freezes decision snapshots, isolates stored copies, and keeps activity/outbox correlation", async () => {
    const h = harness();
    const commit = vi.spyOn(h.unitOfWork, "commit");
    await h.create();
    await h.submit();
    const input = commit.mock.calls.at(-1)![0] as CommandCommitInput<ContentState>;
    const frozen = input.resource.next.state.review!.submitted;
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.attachments)).toBe(true);
    expect(Reflect.set(frozen, "title", "tampered")).toBe(false);
    const detached = await h.current();
    Reflect.set(detached.state.review!.submitted, "title", "changed copy");
    expect((await h.current()).state.review!.submitted.title).toBe("Draft title");
    expect(h.store.activity.at(-1)!.correlationId).toBe(h.store.outbox.at(-1)!.correlationId);
    expect(h.store.outbox.at(-1)!.actor?.subject).toBe("author_1");
  });

  it("uses stable list ordering and explicitly removes old status keys without duplicate actions", async () => {
    const h = harness();
    const commit = vi.spyOn(h.unitOfWork, "commit");
    await h.create();
    await h.submit();
    expect(await h.repository.listProjection("contentItem.status.draft")).toEqual([]);
    expect(await h.repository.listProjection("contentItem.status.inReview")).toHaveLength(1);
    expect((await h.repository.listProjection("contentItem.list"))[0]!.sort).toBe(
      `${now}#${contentId}`,
    );
    const projections = commit.mock.calls.at(-1)![0].projections;
    expect(
      projections.some((row) => row.projectionName === "contentItem.status.draft" && row.delete),
    ).toBe(true);
    expect(
      new Set(projections.map((row) => `${row.projectionName}/${row.sort}/${row.itemId}`)).size,
    ).toBe(projections.length);
  });
});

describe("editorial authorization and stale commands", () => {
  it.each(["editDraft", "submit", "reopenDraft"])(
    "rejects a different author for %s",
    async (command) => {
      const h = harness();
      await h.create();
      if (command === "reopenDraft") await h.submit();
      const expectedVersion = (await h.current()).version;
      const input =
        command === "editDraft"
          ? { expectedVersion, title: "Forbidden", body: "Forbidden" }
          : command === "submit"
            ? { expectedVersion, assignedEditorId: "editor_1", dueAt }
            : { expectedVersion };
      await h.rejected(command, input, "auth.forbidden", "author_2");
    },
  );

  it.each(["approve", "requestChanges", "archive"])(
    "requires an editor for %s",
    async (command) => {
      const h = harness();
      await h.create();
      await h.submit();
      await h.rejected(
        command,
        command === "archive" ? { expectedVersion: 2 } : await h.decisionInput(),
        "auth.forbidden",
      );
    },
  );

  it("does not elevate forged fixture roles, unknown subjects, or external fixture auth", async () => {
    const h = harness();
    await h.create();
    await h.submit();
    for (const auth of [
      { ...fixtureAuth("author_1"), roles: ["author", "editor"] },
      { ...fixtureAuth("editor_1"), subject: "stranger" },
      { ...fixtureAuth("editor_1"), mode: "external" as const },
    ])
      await h.rejected("approve", await h.decisionInput(), "auth.forbidden", auth);
  });

  it("creates editor-owned drafts and rejects a supplied author", async () => {
    const h = harness();
    const created = await h.create("Editor draft", "Body", "editor_2");
    expect(created.state.authorId).toBe("editor_2");
    const other = harness();
    await other.rejected(
      "create",
      { title: "Forged", body: "Body", authorId: "author_1" },
      "command.validation",
      "editor_1",
    );
  });

  it("checks the caller's expected version instead of silently applying to a freshly loaded state", async () => {
    const h = harness();
    await h.create();
    expect(
      (await h.run("editDraft", { expectedVersion: 1, title: "Winner", body: "Body" })).ok,
    ).toBe(true);
    await h.rejected(
      "editDraft",
      { expectedVersion: 1, title: "Stale", body: "Body" },
      "resource.conflict",
    );
    await h.submit();
    await h.rejected(
      "approve",
      { ...(await h.decisionInput()), expectedVersion: 2 },
      "resource.conflict",
      "editor_1",
    );
  });

  it("allows only one concurrent edit to win its commit-time version race", async () => {
    const h = harness();
    await h.create();
    const results = await Promise.all([
      h.run("editDraft", { expectedVersion: 1, title: "First", body: "Body" }),
      h.run("editDraft", { expectedVersion: 1, title: "Second", body: "Body" }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      error: { code: "resource.conflict" },
    });
    expect((await h.current()).version).toBe(2);
    expect(h.store.outbox).toHaveLength(2);
  });

  it("commits only one review fact when duplicate submissions race", async () => {
    const h = harness();
    await h.create();
    const input = { expectedVersion: 1, assignedEditorId: "editor_1", dueAt };
    const results = await Promise.all([h.run("submit", input), h.run("submit", input)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      error: { code: "resource.conflict" },
    });
    expect(
      h.store.outbox.filter((event) => event.eventType === "contentItem.reviewRequested"),
    ).toHaveLength(1);
    expect((await h.current()).version).toBe(2);
  });

  it("rejects wrong review IDs/revisions and delayed approvals after a new submission", async () => {
    const h = harness();
    await h.create();
    await h.submit();
    const old = await h.decisionInput();
    for (const input of [
      { ...old, reviewId: uuid(999) },
      { ...old, revisionId: uuid(998) },
    ])
      await h.rejected("approve", input, "resource.conflict", "editor_1");
    expect((await h.run("reopenDraft", { expectedVersion: 2 })).ok).toBe(true);
    await h.submit();
    await h.rejected("approve", { ...old, expectedVersion: 4 }, "resource.conflict", "editor_1");
  });
});

describe("strict domain boundaries", () => {
  it("normalizes input titles but preserves plain-text body bytes including a BOM", async () => {
    const h = harness();
    const body = "\uFEFF  Body\n ";
    const created = await h.create("  Canonical title  ", body);
    expect(created.state.title).toBe("Canonical title");
    expect(created.state.body).toBe(body);
    expect((await h.submit()).state.review!.submitted.body).toBe(body);
  });

  it("accepts the exact UTF-8 body boundary and rejects malformed Unicode", async () => {
    const h = harness();
    await h.create("Boundary", "\u{1F600}".repeat(8192));
    await h.submit();
    const other = harness();
    for (const input of [
      { title: "\uD800", body: "Body" },
      { title: "Title", body: "\uD800" },
    ])
      await other.rejected("create", input, "command.validation");
  });

  it("rejects noncanonical stored titles and review source versions ahead of content", async () => {
    const h = harness();
    const created = await h.create();
    h.store.resources.set(`contentItem\u0000${contentId}`, {
      ...created,
      state: { ...created.state, title: "  Tampered title  " },
    });
    await h.rejected(
      "editDraft",
      { expectedVersion: 1, title: "Edit", body: "Body" },
      "resource.invalid_state",
    );
    const other = harness();
    await other.create();
    const submitted = await other.submit();
    other.store.resources.set(`contentItem\u0000${contentId}`, {
      ...submitted,
      state: { ...submitted.state, review: { ...submitted.state.review!, sourceVersion: 99 } },
    });
    await other.rejected(
      "approve",
      await other.decisionInput(),
      "resource.invalid_state",
      "editor_1",
    );
  });

  it.each(["invalid", contentId])(
    "rejects a broken ID generator before any commit (%s)",
    async (value) => {
      const h = harness(() => value);
      await h.rejected("create", { title: "Title", body: "Body" }, "runtime.internal");
    },
  );

  it("rejects a reused revision UUID before editing a committed draft", async () => {
    const h = harness(() => uuid(10));
    await h.create();
    await h.rejected(
      "editDraft",
      { expectedVersion: 1, title: "Changed", body: "Changed" },
      "runtime.internal",
    );
  });

  it("rejects mismatched event outcomes, unknown properties, and invalid source versions", async () => {
    const h = harness();
    await h.create();
    const submitted = await h.submit();
    const pending = submitted.state.review!;
    expect(contentEventSchemas["contentItem.reviewRequested"].safeParse(pending).success).toBe(
      true,
    );
    expect(contentEventSchemas["contentItem.reviewDecided"].safeParse(pending).success).toBe(false);
    expect(contentEventSchemas["contentItem.reviewSuperseded"].safeParse(pending).success).toBe(
      false,
    );
    expect(
      contentEventSchemas["contentItem.reviewRequested"].safeParse({ ...pending, injected: true })
        .success,
    ).toBe(false);
    expect(
      contentEventSchemas["contentItem.reviewRequested"].safeParse({ ...pending, sourceVersion: 0 })
        .success,
    ).toBe(false);
    const approved = (await h.approve()).state.review!;
    expect(contentEventSchemas["contentItem.reviewRequested"].safeParse(approved).success).toBe(
      false,
    );
    expect(contentEventSchemas["contentItem.reviewDecided"].safeParse(approved).success).toBe(true);
  });

  it.each([
    { title: "", body: "" },
    { title: "x".repeat(161), body: "" },
    { title: "Title", body: "x".repeat(32769) },
    { title: "Title", body: "\u{1F600}".repeat(8193) },
    { title: "Title", body: "Body", actor: "forged" },
    { title: "Title", body: "Body", status: "approved" },
    { title: "Title", body: "Body", objectKey: "private/key" },
  ])("rejects invalid/oversize/forged create inputs %#", async (input) => {
    const h = harness();
    await h.rejected("create", input, "command.validation");
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"])(
    "rejects invalid expectedVersion (%s)",
    async (expectedVersion) => {
      const h = harness();
      await h.create();
      await h.rejected(
        "editDraft",
        { expectedVersion, title: "Edit", body: "Body" },
        "command.validation",
      );
    },
  );
  it.each([
    { assignedEditorId: "author_2", dueAt },
    { assignedEditorId: "unknown", dueAt },
    { assignedEditorId: "editor_1", dueAt: now },
    { assignedEditorId: "editor_1", dueAt: "2026-10-30T12:00:00.000Z" },
    { assignedEditorId: "editor_1", dueAt: "2026-11-01" },
  ])("rejects an invalid editor or nonfuture/invalid due time: %j", async (input) => {
    const h = harness();
    await h.create();
    await h.rejected("submit", { expectedVersion: 1, ...input }, "command.validation");
  });
  it("bounds review notes, rejects unknown command properties, and validates resource IDs", async () => {
    const h = harness();
    await h.create();
    await h.submit();
    for (const note of ["", " ", "x".repeat(2001)])
      await h.rejected(
        "approve",
        { ...(await h.decisionInput()), note },
        "command.validation",
        "editor_1",
      );
    await h.rejected(
      "approve",
      { ...(await h.decisionInput()), approvedBy: "editor_2" },
      "command.validation",
      "editor_1",
    );
    const fresh = harness();
    await fresh.rejected(
      "create",
      { title: "Title", body: "Body" },
      "command.validation",
      "author_1",
      "../../invalid",
    );
  });
  it("bounds serialized snapshot/state size separately from raw body bytes", async () => {
    const h = harness();
    await h.create("Title", "\u0000".repeat(12000));
    await h.rejected(
      "submit",
      { expectedVersion: 1, assignedEditorId: "editor_1", dueAt },
      "command.validation",
    );
    const other = harness();
    await other.rejected(
      "create",
      { title: "Title", body: "\u0000".repeat(30000) },
      "command.validation",
    );
  });
  it("rejects malformed persisted state before a decision can commit", async () => {
    const h = harness();
    const state = await h.create();
    h.store.resources.set(`contentItem\u0000${contentId}`, {
      ...state,
      state: { ...state.state, injected: true },
    });
    await h.rejected(
      "editDraft",
      { expectedVersion: 1, title: "Edit", body: "Body" },
      "resource.invalid_state",
    );
  });
});

describe("review snapshots are a secondary resource, not editorial authority", () => {
  it("materializes newer complete outcomes and refuses stale/outcome-regressing snapshots", async () => {
    const h = harness();
    await h.create();
    const requested = await h.submit();
    const pending = requested.state.review!;
    expect(
      (
        await h.run(
          "createSnapshot",
          { snapshot: pending },
          service,
          pending.reviewId,
          "reviewTask",
        )
      ).ok,
    ).toBe(true);
    const approved = await h.approve();
    const closed = approved.state.review!;
    expect(
      (
        await h.run(
          "applySnapshot",
          { expectedVersion: 1, snapshot: closed },
          service,
          closed.reviewId,
          "reviewTask",
        )
      ).ok,
    ).toBe(true);
    const materialized = await h.repository.getState<ReviewTaskState>(
      "reviewTask",
      closed.reviewId,
    );
    expect(materialized).toMatchObject({
      version: 2,
      state: { sourceVersion: 3, status: "approved" },
    });
    for (const snapshot of [pending, closed, { ...pending, sourceVersion: 4 }])
      await h.rejected(
        "applySnapshot",
        { expectedVersion: 2, snapshot },
        "command.rejected",
        service,
        closed.reviewId,
        "reviewTask",
      );
    expect(await h.repository.listProjection("reviewTask.pending")).toEqual([]);
    expect(await h.repository.listProjection("reviewTask.list")).toHaveLength(1);
  });
  it("can create an approved review before its older requested fact arrives", async () => {
    const h = harness();
    await h.create();
    await h.submit();
    const approved = await h.approve();
    const review = approved.state.review!;
    expect(
      (await h.run("createSnapshot", { snapshot: review }, service, review.reviewId, "reviewTask"))
        .ok,
    ).toBe(true);
    expect(
      (await h.repository.getState<ReviewTaskState>("reviewTask", review.reviewId))!.state,
    ).toEqual(review);
  });
  it("rejects user/forged service materialization and exposes no review approval command", async () => {
    const h = harness();
    await h.create();
    const submitted = await h.submit();
    const review = submitted.state.review!;
    await h.rejected(
      "createSnapshot",
      { snapshot: review },
      "auth.forbidden",
      "editor_1",
      review.reviewId,
      "reviewTask",
    );
    await h.rejected(
      "createSnapshot",
      { snapshot: review },
      "auth.forbidden",
      { ...fixtureAuth("editor_1"), roles: ["editor", reviewProjectorIdentity.role] },
      review.reviewId,
      "reviewTask",
    );
    await h.rejected(
      "approve",
      await h.decisionInput(),
      "command.rejected",
      "editor_1",
      review.reviewId,
      "reviewTask",
    );
    expect(reviewUi.commands).toEqual({});
  });
  it("cannot replace immutable submitted data or authorize content via a secondary approval", async () => {
    const h = harness();
    await h.create();
    const submitted = await h.submit();
    const review = submitted.state.review!;
    expect(
      (await h.run("createSnapshot", { snapshot: review }, service, review.reviewId, "reviewTask"))
        .ok,
    ).toBe(true);
    await h.rejected(
      "applySnapshot",
      {
        expectedVersion: 1,
        snapshot: {
          ...review,
          sourceVersion: 3,
          submitted: { ...review.submitted, title: "Forged revision" },
        },
      },
      "command.rejected",
      service,
      review.reviewId,
      "reviewTask",
    );
    const fake = reviewTaskStateSchema.parse({
      ...review,
      reviewId: uuid(999),
      sourceVersion: 99,
      status: "approved",
      decision: { actorId: "editor_1", at: now, note: "Approved" },
    });
    expect(
      (await h.run("createSnapshot", { snapshot: fake }, service, fake.reviewId, "reviewTask")).ok,
    ).toBe(true);
    await h.rejected(
      "approve",
      { ...(await h.decisionInput()), reviewId: fake.reviewId },
      "resource.conflict",
      "editor_1",
    );
    expect((await h.current()).state.status).toBe("inReview");
  });
});

describe("pure resource composition and browser metadata", () => {
  it("constructs resources/manifests without generating IDs or starting runtime services", () => {
    const ids = vi.fn(() => {
      throw new Error("No ID generation during configuration");
    });
    const fetch = vi.fn(() => {
      throw new Error("No service requests during configuration");
    });
    vi.stubGlobal("fetch", fetch);
    const random = vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      throw new Error("No random IDs during configuration");
    });
    const resources = createContentOperationsResources({ newId: ids });
    const manifest = createManifest({
      appName: "content-operations",
      stage: "dev",
      resources,
      auth: { mode: "dev", provider: "fixtures" },
      costProfile: {},
      stable: true,
    });
    expect(manifest.resources.map((resource) => resource.name)).toEqual([
      "contentItem",
      "reviewTask",
      "asset",
    ]);
    expect(ids).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(fixtureIdentities).toHaveLength(4);
    expect(contentUi.commands.create).not.toHaveProperty("decide");
  });
  it("bundles shared presentation/schemas without server/domain/AWS imports", async () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const result = await build({
      absWorkingDir: root,
      stdin: {
        contents: 'export { contentUi, reviewUi } from "./src/shared/presentation.ts";',
        resolveDir: root,
        loader: "ts",
      },
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs.some((path) => /shared\/contracts\.ts$/.test(path))).toBe(true);
    expect(
      inputs.some((path) =>
        /(?:src\/(?:domain|lab|aws)|packages\/core\/src|@aws-sdk|aws-cdk|node-http)/.test(path),
      ),
    ).toBe(false);
  });
});
