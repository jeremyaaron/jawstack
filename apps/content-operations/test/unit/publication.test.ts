import { prepareTransaction } from "../support/command-plan";
import { randomUUID } from "node:crypto";
import { marshall } from "@aws-sdk/util-dynamodb";
import { DynamoDbRepository } from "@jawstack/aws-runtime";
import { type AuthContext, type CommandCommitInput } from "@jawstack/core";
import { describe, expect, it } from "vitest";
import { createContentDispatch } from "../../src/application/dispatch";
import { createMemoryPersistence } from "../../src/application/memory";
import { createFixtureClock } from "../../src/application/runtime";
import { createMemoryPump } from "../../src/application/pump";
import { createMemoryNotificationSink } from "../../src/application/notifications";
import { createContentWorkers } from "../../src/application/workers";
import { validateClaimResponse } from "../../src/application/publication-claim";
import { operationKey } from "../../src/application/persistence";
import { createDynamoPersistence } from "../../src/aws/persistence";
import { createContentOperationsResources } from "../../src/domain/resources";
import { dueWorkerIdentity, publisherIdentity } from "../../src/domain/publication-commands";
import {
  contentStateSchema,
  publicationObjectKey,
  contentEventSchemas,
  type ContentState,
} from "../../src/shared/contracts";
import { fixtureAuth, type FixtureId } from "../../src/shared/identities";
import { limits } from "../../src/shared/validation";
import { itemKey, TransactionClient } from "../support/transaction-client";

const contentId = "00000000-0000-4000-8000-000000000001";
const instant = "2026-10-31T12:00:00.000Z";
const dueAt = "2026-10-31T13:00:00.000Z";
const publisher: AuthContext = {
  subject: publisherIdentity.subject,
  roles: [publisherIdentity.role],
  mode: "test",
  claims: {},
};
const dueWorker: AuthContext = {
  subject: dueWorkerIdentity.subject,
  roles: [dueWorkerIdentity.role],
  mode: "test",
  claims: {},
};

async function harness(adapter: "memory" | "dynamo" = "memory") {
  const clock = createFixtureClock(instant);
  const memory = createMemoryPersistence();
  const client = new TransactionClient();
  const factory =
    adapter === "memory" ? memory.factory : createDynamoPersistence({ client, tableName: "test" });
  const repository =
    adapter === "memory"
      ? memory.repository
      : new DynamoDbRepository({ client, tableName: "test" });
  let hook: ((input: CommandCommitInput, scope: Parameters<typeof factory>[0]) => void) | undefined;
  let lastCommit: CommandCommitInput | undefined;
  const dispatch = createContentDispatch({
    clock: clock.now,
    persistence: (scope, now) => {
      const scoped = factory(scope, now);
      return {
        ...scoped,
        unitOfWork: {
          commit: async (input) => {
            lastCommit = input;
            hook?.(input, scope);
            await scoped.unitOfWork.commit(input);
          },
        },
      };
    },
  });
  let sequence = 0;
  const run = (
    commandName: string,
    input: unknown,
    actor: FixtureId | AuthContext = "editor_1",
    key?: string,
  ) =>
    dispatch(
      {
        resourceType: "contentItem",
        resourceId: contentId,
        commandName,
        input,
        idempotencyKey: key ?? `command:${++sequence}`,
        requestId: `request:${++sequence}`,
        correlationId: "publication-proof",
        requestContext: {},
      },
      typeof actor === "string" ? fixtureAuth(actor) : actor,
    );
  const current = async () => (await repository.getState<ContentState>("contentItem", contentId))!;
  const approval = async () => {
    const p = await current();
    return {
      expectedVersion: p.version,
      reviewId: p.state.approval!.reviewId,
      revisionId: p.state.revisionId,
    };
  };
  const reference = async () => {
    const p = await current();
    return {
      expectedVersion: p.version,
      publicationId: p.state.publication!.intent.publicationId,
      generation: p.state.publication!.generation,
    };
  };
  const scheduleRef = async () => {
    const p = await current();
    return {
      expectedVersion: p.version,
      revisionId: p.state.revisionId,
      scheduleGeneration: p.state.schedule!.generation,
    };
  };
  const publish = async () => {
    expect((await run("publishNow", await approval())).ok).toBe(true);
    return (await current()).state.publication!;
  };
  const claim = async (attemptId = randomUUID()) => {
    const input = { ...(await reference()), attemptId };
    const key = `claim:${attemptId}`;
    const result = await run("claimPublication", input, publisher, key);
    expect(result.ok).toBe(true);
    return { input, key, result, publication: (await current()).state.publication! };
  };
  const fence = async () => {
    const p = (await current()).state.publication!;
    return {
      ...(await reference()),
      attemptId: p.claim!.attemptId,
      fencingToken: p.claim!.fencingToken,
    };
  };
  const artifact = async () => ({
    objectKey: publicationObjectKey(
      contentId,
      (await current()).state.publication!.intent.publicationId,
    ),
    sha256: "a".repeat(64),
    size: 100,
  });
  const snapshot = () =>
    structuredClone(
      adapter === "memory"
        ? { store: memory.store, operations: memory.records, idempotency: memory.idempotency }
        : client.items,
    );
  expect(
    (await run("create", { title: "Approved editorial", body: "Frozen body" }, "author_1")).ok,
  ).toBe(true);
  expect(
    (
      await run(
        "submit",
        { expectedVersion: 1, assignedEditorId: "editor_1", dueAt: "2026-11-01T12:00:00.000Z" },
        "author_1",
      )
    ).ok,
  ).toBe(true);
  const submitted = await current();
  expect(
    (
      await run("approve", {
        expectedVersion: submitted.version,
        reviewId: submitted.state.review!.reviewId,
        revisionId: submitted.state.revisionId,
        note: "Approved",
      })
    ).ok,
  ).toBe(true);
  return {
    adapter,
    clock,
    memory,
    client,
    factory,
    repository,
    dispatch,
    run,
    current,
    approval,
    reference,
    scheduleRef,
    publish,
    claim,
    fence,
    artifact,
    snapshot,
    hook: (callback: typeof hook) => {
      hook = callback;
    },
    last: () => lastCommit!,
  };
}

describe.each(["memory", "dynamo"] as const)("%s publication domain", (adapter) => {
  it("schedules, moves exact calendar/due keys, cancels and preserves the approval/revision", async () => {
    const h = await harness(adapter);
    const original = (await h.current()).state;
    expect(
      (
        await h.run("schedule", {
          ...(await h.approval()),
          scheduledAt: "2026-10-31T15:00:00.000+02:00",
          timeZone: "Europe/Paris",
        })
      ).ok,
    ).toBe(true);
    const first = (await h.current()).state.schedule!;
    expect(first.scheduledAt).toBe(dueAt);
    expect(
      (
        await h.run("reschedule", {
          ...(await h.approval()),
          scheduleGeneration: first.generation,
          scheduledAt: "2026-10-31T14:00:00.000Z",
          timeZone: "UTC",
        })
      ).ok,
    ).toBe(true);
    const moved = await h.current();
    expect(moved.state.schedule!.generation).not.toBe(first.generation);
    for (const name of ["contentItem.calendar", "contentItem.duePublication"])
      expect(await h.repository.listProjection(name)).toMatchObject([
        {
          sort: `2026-10-31T14:00:00.000Z#${contentId}`,
          data: { generation: moved.state.schedule!.generation },
        },
      ]);
    expect((await h.run("cancelSchedule", await h.scheduleRef())).ok).toBe(true);
    expect((await h.current()).state).toMatchObject({
      status: "approved",
      schedule: null,
      approval: original.approval,
      revisionId: original.revisionId,
    });
    expect(await h.repository.listProjection("contentItem.duePublication")).toEqual([]);
  });

  it("only admits a current due generation at its cutoff and removes schedule projections atomically", async () => {
    const h = await harness(adapter);
    expect(
      (await h.run("schedule", { ...(await h.approval()), scheduledAt: dueAt, timeZone: "UTC" }))
        .ok,
    ).toBe(true);
    const old = await h.scheduleRef();
    expect(await h.run("requestDuePublication", old, dueWorker)).toMatchObject({
      ok: false,
      error: { code: "command.rejected" },
    });
    expect(
      (
        await h.run("reschedule", {
          ...(await h.approval()),
          scheduleGeneration: old.scheduleGeneration,
          scheduledAt: dueAt,
          timeZone: "UTC",
        })
      ).ok,
    ).toBe(true);
    h.clock.advance(60 * 60 * 1000);
    expect(
      await h.run(
        "requestDuePublication",
        { ...old, expectedVersion: (await h.current()).version },
        dueWorker,
      ),
    ).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
    const current = await h.scheduleRef();
    expect((await h.run("requestDuePublication", current, dueWorker)).ok).toBe(true);
    const publication = (await h.current()).state.publication!;
    expect(publication.intent.schedule?.generation).toBe(current.scheduleGeneration);
    expect(await h.repository.listProjection("contentItem.calendar")).toEqual([]);
    expect(await h.repository.listProjection("contentItem.duePublication")).toEqual([]);
  });

  it("has one authoritative winner for due publication versus cancel/reopen/reschedule", async () => {
    for (const competitor of ["cancelSchedule", "reopenDraft", "reschedule"] as const) {
      for (const dueFirst of [true, false]) {
        const h = await harness(adapter);
        expect(
          (
            await h.run("schedule", {
              ...(await h.approval()),
              scheduledAt: dueAt,
              timeZone: "UTC",
            })
          ).ok,
        ).toBe(true);
        h.clock.advance(60 * 60 * 1000);
        const ref = await h.scheduleRef();
        const input =
          competitor === "reschedule"
            ? {
                ...(await h.approval()),
                scheduleGeneration: ref.scheduleGeneration,
                scheduledAt: "2026-10-31T15:00:00.000Z",
                timeZone: "UTC",
              }
            : competitor === "reopenDraft"
              ? { expectedVersion: ref.expectedVersion }
              : ref;
        const calls = [
          () => h.run("requestDuePublication", ref, dueWorker),
          () => h.run(competitor, input),
        ];
        if (!dueFirst) calls.reverse();
        const results = await Promise.all(calls.map((call) => call()));
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok)).toMatchObject([
          { error: { code: "resource.conflict" } },
        ]);
      }
    }
  });

  it("races initial scheduling against reopen and cannot schedule an invalidated signoff", async () => {
    for (const scheduleFirst of [true, false]) {
      const h = await harness(adapter);
      const reference = await h.approval();
      const calls = [
        () => h.run("schedule", { ...reference, scheduledAt: dueAt, timeZone: "UTC" }),
        () => h.run("reopenDraft", { expectedVersion: reference.expectedVersion }),
      ];
      if (!scheduleFirst) calls.reverse();
      const results = await Promise.all(calls.map((call) => call()));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      if ((await h.current()).state.status === "draft")
        expect(
          await h.run("schedule", {
            ...reference,
            expectedVersion: (await h.current()).version,
            scheduledAt: dueAt,
            timeZone: "UTC",
          }),
        ).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
    }
  });

  it("freezes one intent, claims it once concurrently, commits success and keeps history when archived", async () => {
    const h = await harness(adapter);
    const intent = (await h.publish()).intent;
    const attemptId = randomUUID();
    const input = { ...(await h.reference()), attemptId };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => h.run("claimPublication", input, publisher, "same-claim")),
    );
    expect(results[0]!.ok).toBe(true);
    for (const r of results) expect(r).toEqual(results[0]);
    const active = (await h.current()).state.publication!;
    expect(Date.parse(active.claim!.leaseUntil) - Date.parse(active.claim!.startedAt)).toBe(90_000);
    expect(
      await h.run(
        "claimPublication",
        { ...(await h.reference()), attemptId: randomUUID() },
        publisher,
      ),
    ).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
    expect(
      (
        await h.run(
          "completePublication",
          { ...(await h.fence()), artifact: await h.artifact() },
          publisher,
        )
      ).ok,
    ).toBe(true);
    const published = await h.current();
    expect(published.state).toMatchObject({
      status: "published",
      publication: {
        phase: "succeeded",
        claim: null,
        intent,
        artifact: { sha256: "a".repeat(64) },
      },
    });
    expect(
      await h.repository.listProjection(`contentItem.publicationAttempts.${contentId}`),
    ).toMatchObject([{ data: { attempt: { status: "succeeded" } } }]);
    expect((await h.run("archive", { expectedVersion: published.version })).ok).toBe(true);
    expect((await h.current()).state.publication!.intent).toEqual(intent);
    expect((await h.current()).state.publication!.artifact).toEqual(
      published.state.publication!.artifact,
    );
    const serialized = JSON.stringify(h.last().outbox);
    expect(serialized).not.toContain(active.claim!.fencingToken);
  });

  it("rejects expired claim response replays and requires both a fresh attempt and key", async () => {
    const h = await harness(adapter);
    await h.publish();
    const first = await h.claim();
    expect(await h.run("claimPublication", first.input, publisher, first.key)).toEqual(
      first.result,
    );
    const shifted = {
      ...first.publication.claim!,
      startedAt: new Date(h.clock.now().getTime() + 1000).toISOString(),
      leaseUntil: new Date(
        h.clock.now().getTime() + limits.publicationLeaseMs + 1000,
      ).toISOString(),
    };
    expect(
      await validateClaimResponse(
        {
          resourceType: "contentItem",
          resourceId: contentId,
          commandName: "claimPublication",
          input: first.input,
          idempotencyKey: first.key,
          requestContext: {},
        },
        {
          ok: true,
          meta: first.result.meta,
          data: { ...(first.result.ok ? (first.result.data as object) : {}), claim: shifted },
        },
        h.repository,
        h.clock.now,
      ),
    ).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
    h.clock.advance(limits.publicationLeaseMs);
    const before = h.snapshot();
    expect(await h.run("claimPublication", first.input, publisher, first.key)).toMatchObject({
      ok: false,
      error: { code: "resource.conflict" },
    });
    expect(h.snapshot()).toEqual(before);
    expect(
      await h.run(
        "claimPublication",
        { ...(await h.reference()), attemptId: randomUUID() },
        publisher,
        first.key,
      ),
    ).toMatchObject({ ok: false, error: { code: "idempotency.conflict" } });
    expect(
      await h.run(
        "claimPublication",
        { ...(await h.reference()), attemptId: first.input.attemptId },
        publisher,
        "old-attempt-new-key",
      ),
    ).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
    const second = await h.claim();
    expect(second.publication.claim!.fencingToken).not.toBe(first.publication.claim!.fencingToken);
  });

  it("fences old attempts, including completion/failure after takeover and generation retry", async () => {
    const h = await harness(adapter);
    const intent = (await h.publish()).intent;
    const first = await h.claim();
    const old = await h.fence();
    h.clock.advance(limits.publicationLeaseMs);
    for (const command of ["completePublication", "failPublication"] as const)
      expect(
        await h.run(
          command,
          {
            ...old,
            ...(command === "completePublication"
              ? { artifact: await h.artifact() }
              : { failureCode: "storage.unavailable" }),
          },
          publisher,
        ),
      ).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
    await h.claim();
    const current = await h.current();
    for (const command of ["completePublication", "failPublication"] as const)
      expect(
        await h.run(
          command,
          {
            ...old,
            expectedVersion: current.version,
            ...(command === "completePublication"
              ? { artifact: await h.artifact() }
              : { failureCode: "storage.unavailable" }),
          },
          publisher,
        ),
      ).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
    h.clock.advance(limits.publicationLeaseMs);
    expect((await h.run("retryPublication", await h.reference())).ok).toBe(true);
    expect((await h.current()).state.publication).toMatchObject({
      generation: 2,
      attemptsInGeneration: 0,
      phase: "queued",
      intent,
    });
    expect(
      await h.run(
        "claimPublication",
        { ...(await h.reference()), generation: 1, attemptId: randomUUID() },
        publisher,
      ),
    ).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
    expect(
      await h.run(
        "completePublication",
        { ...old, expectedVersion: (await h.current()).version, artifact: await h.artifact() },
        publisher,
      ),
    ).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
    expect(first.publication.intent).toEqual(intent);
  });

  it.each(["expired", "failed"] as const)(
    "keeps editing/scheduling/archiving locked while publication is %s",
    async (outcome) => {
      const h = await harness(adapter);
      await h.publish();
      await h.claim();
      if (outcome === "expired") h.clock.advance(limits.publicationLeaseMs);
      else
        expect(
          (
            await h.run(
              "failPublication",
              { ...(await h.fence()), failureCode: "artifact.mismatch" },
              publisher,
            )
          ).ok,
        ).toBe(true);
      const before = h.snapshot();
      const reference = await h.approval();
      for (const [command, input] of [
        [
          "editDraft",
          { expectedVersion: reference.expectedVersion, title: "Unsafe edit", body: "Body" },
        ],
        [
          "submit",
          {
            expectedVersion: reference.expectedVersion,
            assignedEditorId: "editor_1",
            dueAt: "2026-11-01T12:00:00.000Z",
          },
        ],
        [
          "registerAsset",
          {
            expectedVersion: reference.expectedVersion,
            filename: "x.png",
            expectedSize: 100,
            mediaType: "image/png",
          },
        ],
        ["removeAsset", { expectedVersion: reference.expectedVersion, assetId: randomUUID() }],
        ["reopenDraft", { expectedVersion: reference.expectedVersion }],
        ["archive", { expectedVersion: reference.expectedVersion }],
        ["schedule", { ...reference, scheduledAt: dueAt, timeZone: "UTC" }],
      ] as const)
        expect((await h.run(command, input)).ok).toBe(false);
      expect(h.snapshot()).toEqual(before);
      expect((await h.current()).state.status).toBe("publishing");
    },
  );

  it("bounds attempts and manual generations without changing artifact identity or requested time", async () => {
    const h = await harness(adapter);
    const intent = (await h.publish()).intent;
    for (let generation = 1; generation <= limits.publicationGenerations; generation++) {
      for (let attempt = 0; attempt < limits.publicationAttempts; attempt++) {
        await h.claim();
        expect(
          (
            await h.run(
              "failPublication",
              { ...(await h.fence()), failureCode: "storage.unavailable" },
              publisher,
            )
          ).ok,
        ).toBe(true);
      }
      expect((await h.current()).state.publication!.phase).toBe("failed");
      expect(
        await h.run(
          "claimPublication",
          { ...(await h.reference()), attemptId: randomUUID() },
          publisher,
        ),
      ).toMatchObject({ ok: false });
      const result = await h.run("retryPublication", await h.reference());
      expect(result.ok).toBe(generation < limits.publicationGenerations);
      expect((await h.current()).state.publication!.intent).toEqual(intent);
    }
    expect(
      await h.repository.listProjection(`contentItem.publicationAttempts.${contentId}`),
    ).toHaveLength(12);
  });

  it("prevents reusing an older attempt via durable claim-history conditions, with full rollback", async () => {
    const h = await harness(adapter);
    await h.publish();
    const first = await h.claim();
    h.clock.advance(limits.publicationLeaseMs);
    await h.claim();
    h.clock.advance(limits.publicationLeaseMs);
    const before = h.snapshot();
    expect(
      await h.run(
        "claimPublication",
        { ...(await h.reference()), attemptId: first.input.attemptId },
        publisher,
        "reused-history-attempt",
      ),
    ).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
    expect(h.snapshot()).toEqual(before);
    expect((await h.run("retryPublication", await h.reference())).ok).toBe(true);
    const newGeneration = h.snapshot();
    expect(
      await h.run(
        "claimPublication",
        { ...(await h.reference()), attemptId: first.input.attemptId },
        publisher,
        "reused-across-generation",
      ),
    ).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
    expect(h.snapshot()).toEqual(newGeneration);
    for (let attempt = 0; attempt < limits.publicationAttempts; attempt++) {
      await h.claim();
      h.clock.advance(limits.publicationLeaseMs);
    }
    const exhausted = h.snapshot();
    expect(
      await h.run(
        "claimPublication",
        { ...(await h.reference()), attemptId: randomUUID() },
        publisher,
      ),
    ).toMatchObject({ ok: false, error: { code: "command.rejected" } });
    expect(h.snapshot()).toEqual(exhausted);
    expect((await h.current()).state).toMatchObject({
      status: "publishing",
      publication: { phase: "running", attemptsInGeneration: 3 },
    });
    expect((await h.run("retryPublication", await h.reference())).ok).toBe(true);
    expect((await h.current()).state.publication).toMatchObject({
      generation: 3,
      phase: "queued",
      attemptsInGeneration: 0,
    });
  });

  it("rolls back state/activity/outbox/projections/idempotency if a typed operation condition fails", async () => {
    const h = await harness(adapter);
    await h.publish();
    let before: ReturnType<typeof h.snapshot> | undefined;
    h.hook((input, scope) => {
      const plan = prepareTransaction(input, scope, h.clock.now(), "test");
      const record = plan.operations.find((operation) => operation.kind === "publicationAttempt")!;
      if (adapter === "memory")
        h.memory.records.set(JSON.stringify(operationKey(record)), {
          collection: record.kind,
          owner: { resourceType: "contentItem", resourceId: record.contentId },
          value: record,
        });
      else {
        const item = marshall({ ...operationKey(record), itemKind: "APP_OPERATION", ...record });
        h.client.items.set(itemKey(item), item);
      }
      before = h.snapshot();
    });
    expect(
      await h.run(
        "claimPublication",
        { ...(await h.reference()), attemptId: randomUUID() },
        publisher,
      ),
    ).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
    expect(h.snapshot()).toEqual(before);
  });

  it("does not retry queued work or burn another generation using a previous cycle's failure", async () => {
    const h = await harness(adapter);
    await h.publish();
    expect(await h.run("retryPublication", await h.reference())).toMatchObject({
      ok: false,
      error: { code: "command.rejected" },
    });
    const first = await h.claim();
    expect(await h.run("retryPublication", await h.reference())).toMatchObject({
      ok: false,
      error: { code: "resource.conflict" },
    });
    expect(
      (
        await h.run(
          "failPublication",
          { ...(await h.fence()), failureCode: "storage.unavailable" },
          publisher,
        )
      ).ok,
    ).toBe(true);
    expect(await h.run("claimPublication", first.input, publisher, first.key)).toMatchObject({
      ok: false,
      error: { code: "resource.conflict" },
    });
    const input = await h.reference();
    const retry = await h.run("retryPublication", input, "editor_1", "retry-once");
    expect(retry.ok).toBe(true);
    expect(await h.run("retryPublication", input, "editor_1", "retry-once")).toEqual(retry);
    const before = h.snapshot();
    expect(await h.run("retryPublication", await h.reference())).toMatchObject({
      ok: false,
      error: { code: "command.rejected" },
    });
    expect(h.snapshot()).toEqual(before);
  });

  it("requires every current publication/generation/attempt/token fence field for outcomes", async () => {
    const h = await harness(adapter);
    await h.publish();
    const claimed = await h.claim();
    const fence = await h.fence();
    const before = h.snapshot();
    for (const fields of [
      { publicationId: randomUUID() },
      { generation: fence.generation + 1 },
      { attemptId: randomUUID() },
      { fencingToken: randomUUID() },
    ]) {
      for (const command of ["completePublication", "failPublication"] as const)
        expect(
          await h.run(
            command,
            {
              ...fence,
              ...fields,
              ...(command === "completePublication"
                ? { artifact: await h.artifact() }
                : { failureCode: "execution.interrupted" }),
            },
            publisher,
          ),
        ).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
    }
    const backwards = createContentDispatch({
      persistence: h.factory,
      clock: () => new Date("2026-10-31T11:59:00.000Z"),
    });
    for (const [commandName, input, key] of [
      ["claimPublication", claimed.input, claimed.key],
      [
        "failPublication",
        { ...fence, failureCode: "execution.interrupted" },
        "clock-regressed-failure",
      ],
    ] as const)
      expect(
        await backwards(
          {
            resourceType: "contentItem",
            resourceId: contentId,
            commandName,
            input,
            idempotencyKey: key,
            requestContext: {},
          },
          publisher,
        ),
      ).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
    expect(h.snapshot()).toEqual(before);
  });
});

describe("publication boundaries", () => {
  it.each([
    { scheduledAt: "2026-11-01T12:00:00.000", timeZone: "UTC" },
    { scheduledAt: "2026-02-30T12:00:00.000Z", timeZone: "UTC" },
    { scheduledAt: dueAt, timeZone: "Not/AZone" },
    { scheduledAt: dueAt, timeZone: "+02:00" },
    { scheduledAt: dueAt, timeZone: "UTC", generation: randomUUID() },
    { scheduledAt: instant, timeZone: "UTC" },
  ])("rejects invalid schedule fields without committing %j", async (fields) => {
    const h = await harness();
    const before = h.snapshot();
    expect(await h.run("schedule", { ...(await h.approval()), ...fields })).toMatchObject({
      ok: false,
      error: { code: "command.validation" },
    });
    expect(h.snapshot()).toEqual(before);
  });

  it("requires editor/service identities rather than forged roles and rejects stale approval references", async () => {
    const h = await harness();
    const input = await h.approval();
    for (const auth of [fixtureAuth("author_1"), { ...fixtureAuth("author_1"), roles: ["editor"] }])
      expect(await h.run("publishNow", input, auth)).toMatchObject({
        ok: false,
        error: { code: "auth.forbidden" },
      });
    expect(await h.run("publishNow", { ...input, reviewId: randomUUID() })).toMatchObject({
      ok: false,
      error: { code: "resource.conflict" },
    });
    await h.publish();
    for (const auth of [
      fixtureAuth("editor_1"),
      { ...fixtureAuth("editor_1"), roles: [publisherIdentity.role] },
      { ...publisher, mode: "external" as const },
    ])
      expect(
        await h.run(
          "claimPublication",
          { ...(await h.reference()), attemptId: randomUUID() },
          auth,
        ),
      ).toMatchObject({ ok: false, error: { code: "auth.forbidden" } });
  });

  it("validates artifact identity/size/digest and never permits raw failure messages", async () => {
    const h = await harness();
    await h.publish();
    await h.claim();
    const before = h.snapshot();
    for (const artifact of [
      { ...(await h.artifact()), objectKey: "publications/other/snapshot.json" },
      { ...(await h.artifact()), size: limits.publicationArtifactBytes + 1 },
      { ...(await h.artifact()), sha256: "not-a-digest" },
    ])
      expect(
        (await h.run("completePublication", { ...(await h.fence()), artifact }, publisher)).ok,
      ).toBe(false);
    expect(
      await h.run(
        "failPublication",
        {
          ...(await h.fence()),
          failureCode: "storage.unavailable",
          message: "secret exception stack",
        },
        publisher,
      ),
    ).toMatchObject({ ok: false, error: { code: "command.validation" } });
    expect(h.snapshot()).toEqual(before);
  });

  it("registers publication work but a composition without its executor cannot acknowledge it", async () => {
    const h = await harness();
    await h.publish();
    const request = h
      .last()
      .outbox.find((event) => event.eventType === "contentItem.publicationRequested")!;
    expect(
      contentEventSchemas["contentItem.publicationRequested"].safeParse(request.payload).success,
    ).toBe(true);
    expect(
      createContentOperationsResources()[0].workers.some(
        (worker) => worker.name === "publishContent",
      ),
    ).toBe(true);
    const workers = createContentWorkers({
      repository: h.repository,
      dispatch: h.dispatch,
      notifications: createMemoryNotificationSink({ store: h.memory.store }),
      clock: h.clock.now,
    });
    const pump = createMemoryPump({
      outbox: () => h.memory.store.outbox,
      workers,
      clock: h.clock.now,
    });
    await pump.drain();
    await pump.drain();
    expect(workers.subscribers("contentItem.publicationRequested")).toEqual(["publishContent"]);
    expect((await h.current()).state.publication).toMatchObject({
      phase: "queued",
      artifact: null,
    });
    expect(
      contentStateSchema.safeParse({ ...(await h.current()).state, status: "published" }).success,
    ).toBe(false);
  });

  it.each(["artifact.mismatch", "snapshot.invalid"] as const)(
    "classifies %s as terminal on the first attempt",
    async (failureCode) => {
      const h = await harness();
      await h.publish();
      await h.claim();
      expect(
        (await h.run("failPublication", { ...(await h.fence()), failureCode }, publisher)).ok,
      ).toBe(true);
      expect((await h.current()).state.publication).toMatchObject({
        phase: "failed",
        attemptsInGeneration: 1,
        claim: null,
      });
      expect(h.last().outbox.map((event) => event.eventType)).toEqual([
        "contentItem.publicationAttemptFailed",
        "contentItem.publicationFailed",
      ]);
    },
  );

  it("rejects malformed stored intent/lease/phase state before another decision can commit", async () => {
    const h = await harness();
    await h.publish();
    await h.claim();
    const previous = await h.current();
    const publication = previous.state.publication!;
    for (const candidate of [
      { ...previous.state, publication: null },
      {
        ...previous.state,
        publication: {
          ...publication,
          intent: {
            ...publication.intent,
            snapshot: { ...publication.intent.snapshot, body: "Mutated frozen body" },
          },
        },
      },
      { ...previous.state, publication: { ...publication, phase: "succeeded" } },
      {
        ...previous.state,
        publication: {
          ...publication,
          claim: { ...publication.claim!, fencingToken: publication.claim!.attemptId },
        },
      },
    ])
      expect(contentStateSchema.safeParse(candidate).success).toBe(false);
    h.memory.store.resources.set(`contentItem\0${contentId}`, {
      ...previous,
      state: {
        ...previous.state,
        publication: {
          ...publication,
          intent: {
            ...publication.intent,
            snapshot: { ...publication.intent.snapshot, body: "Corrupt" },
          },
        },
      },
    });
    expect(
      await h.run(
        "claimPublication",
        { ...(await h.reference()), attemptId: randomUUID() },
        publisher,
      ),
    ).toMatchObject({ ok: false, error: { code: "resource.invalid_state" } });
  });

  it("retains primary/idempotency conditions and the 60-action budget with typed history, without leaking fencing tokens", async () => {
    const h = await harness();
    await h.publish();
    await h.claim();
    const input = h.last();
    const scope = {
      resourceType: "contentItem",
      commandName: "claimPublication",
      subject: publisherIdentity.subject,
    };
    const base = prepareTransaction(input, scope, h.clock.now(), "test");
    const extra = Array.from({ length: 60 - base.items.length }, () => ({
      projectionName: "contentItem.budget",
      itemId: randomUUID(),
      sort: instant,
      data: {},
    }));
    const bounded = { ...input, projections: [...input.projections, ...extra] };
    const plan = prepareTransaction(bounded, scope, h.clock.now(), "test");
    expect(plan.items).toHaveLength(60);
    expect(plan.items[0]!.Put!.ConditionExpression).toBe("#version = :expectedVersion");
    expect(plan.items[plan.idempotencyIndex]!.Put!.ConditionExpression).toBe(
      "attribute_not_exists(PK) OR #expires <= :now",
    );
    expect(() =>
      prepareTransaction(
        {
          ...bounded,
          projections: [...bounded.projections, { ...extra[0]!, itemId: randomUUID() }],
        },
        scope,
        h.clock.now(),
        "test",
      ),
    ).toThrow("action budget");
    expect(() =>
      prepareTransaction({ ...input, outbox: [] }, scope, h.clock.now(), "test"),
    ).toThrow("publication operation");
    const token = (await h.current()).state.publication!.claim!.fencingToken;
    expect(JSON.stringify(h.memory.store.outbox)).not.toContain(token);
    expect(JSON.stringify([...h.memory.records.values()])).not.toContain(token);
    expect(JSON.stringify([...h.memory.store.projections.values()])).not.toContain(token);
  });

  it("rejects a broken ID generator before minting publication identity or schedule generation", async () => {
    const h = await harness();
    const dispatch = createContentDispatch({
      persistence: h.memory.factory,
      clock: h.clock.now,
      registry: createContentOperationsResources({ newId: () => contentId }),
    });
    const before = h.snapshot();
    for (const commandName of ["publishNow", "schedule"])
      expect(
        await dispatch(
          {
            resourceType: "contentItem",
            resourceId: contentId,
            commandName,
            input: {
              ...(await h.approval()),
              ...(commandName === "schedule" ? { scheduledAt: dueAt, timeZone: "UTC" } : {}),
            },
            idempotencyKey: commandName,
            requestContext: {},
          },
          fixtureAuth("editor_1"),
        ),
      ).toMatchObject({ ok: false, error: { code: "runtime.internal" } });
    expect(h.snapshot()).toEqual(before);
  });
});
