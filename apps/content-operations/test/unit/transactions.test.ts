import { GetItemCommand, QueryCommand, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  DynamoDbRepository,
  type DynamoDbClientLike,
  type DynamoDbItem,
} from "@jawstack/aws-runtime";
import { type CommandCommitInput, type ResourceState } from "@jawstack/core";
import { describe, expect, it } from "vitest";
import { createContentDispatch } from "../../src/application/dispatch";
import { createMemoryPersistence } from "../../src/application/memory";
import {
  idempotencyTtlSeconds,
  operationKey,
  prepareTransaction,
  type CommandScope,
  type OperationRecord,
} from "../../src/application/persistence";
import { createDynamoPersistence } from "../../src/aws/persistence";
import { fixtureAuth } from "../../src/shared/identities";

const instant = "2026-10-31T12:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope: CommandScope = {
  resourceType: "contentItem",
  commandName: "create",
  subject: "author_1",
};
const keyOf = (item: DynamoDbItem) => JSON.stringify([item.PK, item.SK]);

// A deliberately narrow SDK contract double. Unknown actions/conditions fail, not silently succeed.
class TransactionClient implements DynamoDbClientLike {
  items = new Map<string, DynamoDbItem>();
  transactions: TransactWriteItemsCommand["input"][] = [];
  failure: Error | undefined;
  async send(command: { input: unknown }): Promise<unknown> {
    if (command instanceof GetItemCommand)
      return { Item: structuredClone(this.items.get(keyOf(command.input.Key!))) };
    if (command instanceof QueryCommand) {
      const pk = command.input.ExpressionAttributeValues![":pk"];
      const prefix = command.input.ExpressionAttributeValues![":skPrefix"]?.S ?? "";
      return {
        Items: [...this.items.values()].filter(
          (item) => item.PK!.S === pk!.S && item.SK!.S!.startsWith(prefix),
        ),
      };
    }
    if (!(command instanceof TransactWriteItemsCommand)) throw new Error("Unexpected command");
    this.transactions.push(structuredClone(command.input));
    if (this.failure) throw this.failure;
    const writes = command.input.TransactItems!;
    const keys = writes.map((w) => keyOf(w.Put?.Item ?? w.Delete!.Key!));
    expect(new Set(keys).size).toBe(keys.length);
    const reasons = writes.map((write, i) => {
      const put = write.Put;
      const current = this.items.get(keys[i]!);
      let allowed = true;
      if (put?.ConditionExpression) {
        const values = unmarshall(put.ExpressionAttributeValues ?? {});
        const old = current ? unmarshall(current) : undefined;
        switch (put.ConditionExpression) {
          case "attribute_not_exists(PK)":
            allowed = !old;
            break;
          case "#version = :expectedVersion":
            allowed = old?.version === values[":expectedVersion"];
            break;
          case "attribute_not_exists(PK) OR expiresAt <= :now":
            allowed =
              !old || (typeof old.expiresAt === "number" && old.expiresAt <= values[":now"]);
            break;
          default:
            throw new Error("Unexpected condition");
        }
      }
      return { Code: allowed ? "None" : "ConditionalCheckFailed" };
    });
    if (reasons.some((r) => r.Code !== "None"))
      throw Object.assign(new Error("Cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: reasons,
      });
    const staged = structuredClone(this.items);
    writes.forEach((write, i) => {
      if (write.Put) staged.set(keys[i]!, structuredClone(write.Put.Item!));
      else staged.delete(keys[i]!);
    });
    this.items = staged;
    return {};
  }
}

function harness(adapter: "memory" | "dynamo") {
  let now = new Date(instant);
  const memory = createMemoryPersistence();
  const client = new TransactionClient();
  const factory =
    adapter === "memory" ? memory.factory : createDynamoPersistence({ client, tableName: "test" });
  const repository =
    adapter === "memory"
      ? memory.repository
      : new DynamoDbRepository({ client, tableName: "test" });
  const dispatch = createContentDispatch({ persistence: factory, clock: () => now });
  const run = (
    commandName: string,
    input: unknown,
    key = commandName,
    subject: "author_1" | "author_2" | "editor_1" = "author_1",
    id = uuid(1),
  ) =>
    dispatch(
      {
        resourceType: "contentItem",
        resourceId: id,
        commandName,
        input,
        idempotencyKey: key,
        requestContext: {},
      },
      fixtureAuth(subject),
    );
  const snapshot = () =>
    structuredClone(
      adapter === "memory"
        ? { store: memory.store, operations: memory.operations, idempotency: memory.idempotency }
        : client.items,
    );
  const records = () =>
    adapter === "memory"
      ? [...memory.operations.values()]
      : [...client.items.values()]
          .map((v) => unmarshall(v))
          .filter((v) => v.itemKind === "APP_OPERATION");
  const seedOperation = (operation: OperationRecord) => {
    if (adapter === "memory")
      memory.operations.set(JSON.stringify(operationKey(operation)), operation);
    else {
      const item = marshall({
        ...operationKey(operation),
        ...operation,
        itemKind: "APP_OPERATION",
      });
      client.items.set(keyOf(item), item);
    }
  };
  return {
    run,
    dispatch,
    factory,
    repository,
    memory,
    client,
    snapshot,
    records,
    seedOperation,
    advance: (seconds: number) => {
      now = new Date(now.getTime() + seconds * 1000);
    },
  };
}

describe.each(["memory", "dynamo"] as const)("scoped %s persistence", (adapter) => {
  it("replays the original response concurrently without duplicating any effects", async () => {
    const h = harness(adapter);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => h.run("create", { title: "Draft", body: "Body" }, "same")),
    );
    expect(results[0]!.ok).toBe(true);
    for (const result of results) expect(result).toEqual(results[0]);
    expect(h.records()).toHaveLength(1);
    expect(await h.repository.getActivity("contentItem", uuid(1))).toHaveLength(1);
    const before = h.snapshot();
    expect(await h.run("create", { title: "Draft", body: "Body" }, "same")).toEqual(results[0]);
    expect(h.snapshot()).toEqual(before);
    expect(await h.run("create", { title: "Different", body: "Body" }, "same")).toMatchObject({
      ok: false,
      error: { code: "idempotency.conflict" },
    });
    expect(
      await h.run("create", { title: "Draft", body: "Body" }, "same", "author_1", uuid(2)),
    ).toMatchObject({ ok: false, error: { code: "idempotency.conflict" } });
    expect(h.snapshot()).toEqual(before);
  });

  it("isolates simultaneous subject and command scopes using the same key", async () => {
    const h = harness(adapter);
    const results = await Promise.all([
      h.run("create", { title: "One", body: "Body" }, "shared", "author_1"),
      h.run("create", { title: "Two", body: "Body" }, "shared", "author_2", uuid(2)),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(
      (await h.run("editDraft", { expectedVersion: 1, title: "Edited", body: "Body" }, "shared"))
        .ok,
    ).toBe(true);
    expect(h.records()).toHaveLength(3);
    expect(await h.run("create", { title: "One", body: "Body" }, "shared")).toEqual(results[0]);
    expect(
      await h.run("create", { title: "Two", body: "Body" }, "shared", "author_2", uuid(2)),
    ).toEqual(results[1]);
  });

  it("logically expires at seven days and atomically replaces an undeleted TTL record", async () => {
    const h = harness(adapter);
    const first = await h.run("create", { title: "Draft", body: "Body" }, "ttl");
    h.advance(idempotencyTtlSeconds - 1);
    expect(await h.run("create", { title: "Draft", body: "Body" }, "ttl")).toEqual(first);
    h.advance(1);
    const replacement = await h.run(
      "create",
      { title: "New", body: "New body" },
      "ttl",
      "author_1",
      uuid(2),
    );
    expect(replacement.ok).toBe(true);
    expect(replacement).not.toEqual(first);
    expect(h.records()).toHaveLength(2);
    expect(
      await h.run("create", { title: "New", body: "New body" }, "ttl", "author_1", uuid(2)),
    ).toEqual(replacement);
  });

  it("returns the winner for concurrent edits and never automatically applies stale edits", async () => {
    const h = harness(adapter);
    await h.run("create", { title: "Draft", body: "Body" });
    const edits = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.run("editDraft", { expectedVersion: 1, title: "New", body: "Body" }, "edit"),
      ),
    );
    expect(edits[0]!.ok).toBe(true);
    for (const edit of edits) expect(edit).toEqual(edits[0]);
    const before = h.snapshot();
    expect(
      await h.run("editDraft", { expectedVersion: 1, title: "Stale", body: "Body" }, "other"),
    ).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
    expect(h.snapshot()).toEqual(before);
  });

  it("rolls back state, activity, outbox, projections, and idempotency on an auxiliary condition failure", async () => {
    const h = harness(adapter);
    h.seedOperation({
      kind: "commandReceipt",
      ...scope,
      resourceId: uuid(1),
      version: 1,
      committedAt: instant,
    });
    const before = h.snapshot();
    expect(await h.run("create", { title: "Draft", body: "Body" })).toMatchObject({
      ok: false,
      error: { code: "resource.conflict" },
    });
    expect(h.snapshot()).toEqual(before);
  });

  it("deletes old status/due rows during submit, reopen and archive", async () => {
    const h = harness(adapter);
    expect((await h.run("create", { title: "Draft", body: "Body" })).ok).toBe(true);
    expect(
      (
        await h.run("submit", {
          expectedVersion: 1,
          assignedEditorId: "editor_1",
          dueAt: "2026-11-01T12:00:00.000Z",
        })
      ).ok,
    ).toBe(true);
    expect(await h.repository.listProjection("contentItem.status.draft")).toEqual([]);
    expect(await h.repository.listProjection("contentItem.dueReview")).toHaveLength(1);
    expect((await h.run("reopenDraft", { expectedVersion: 2 })).ok).toBe(true);
    expect(await h.repository.listProjection("contentItem.dueReview")).toEqual([]);
    expect(await h.repository.listProjection("contentItem.status.inReview")).toEqual([]);
    expect((await h.run("archive", { expectedVersion: 3 }, "archive", "editor_1")).ok).toBe(true);
    expect(await h.repository.listProjection("contentItem.list")).toEqual([]);
    expect(await h.repository.listProjection("contentItem.status.draft")).toEqual([]);
    expect(h.records()).toHaveLength(4);
  });

  it("requires a bounded key before touching persistence", async () => {
    const h = harness(adapter);
    for (const key of ["", " ", "x".repeat(201), "unsafe#key", "key\n", "\u00e9"])
      expect(await h.run("create", { title: "Draft", body: "Body" }, key)).toMatchObject({
        ok: false,
        error: { code: "command.rejected" },
      });
    expect(
      await h.dispatch(
        {
          resourceType: "contentItem",
          commandName: "create",
          input: { title: "Draft", body: "Body" },
          requestContext: {},
        },
        fixtureAuth("author_1"),
      ),
    ).toMatchObject({ ok: false, error: { code: "command.rejected" } });
    expect(h.records()).toEqual([]);
  });

  it("accepts an opaque ingress context without cloning it or resolving auth again", async () => {
    const h = harness(adapter);
    const result = await h.dispatch(
      {
        resourceType: "contentItem",
        commandName: "create",
        input: { title: "Draft", body: "Body" },
        idempotencyKey: "context",
        requestContext: {
          resolve: () => {
            throw new Error("Ingress already resolved identity");
          },
        },
      },
      fixtureAuth("author_1"),
    );
    expect(result.ok).toBe(true);
  });

  it("keeps scope and time private to each factory invocation", async () => {
    const h = harness(adapter);
    const mutable = { ...scope };
    const now = new Date(instant);
    const invocation = h.factory(mutable, now);
    mutable.subject = "author_2";
    now.setUTCFullYear(2030);
    await invocation.unitOfWork.commit(commitInput());
    expect(
      await h.factory(scope, new Date(instant)).repository.getIdempotency!("key"),
    ).toBeDefined();
    expect(
      await h.factory(mutable, new Date(instant)).repository.getIdempotency!("key"),
    ).toBeUndefined();
  });

  it("isolates resource types and rejects over-budget commits atomically", async () => {
    const h = harness(adapter);
    await h.factory(scope, new Date(instant)).unitOfWork.commit(commitInput());
    const review = commitInput();
    await h.factory({ ...scope, resourceType: "reviewTask" }, new Date(instant)).unitOfWork.commit({
      ...review,
      resource: {
        ...review.resource,
        resourceType: "reviewTask",
        next: { ...review.resource.next, resourceType: "reviewTask" },
      },
    });
    expect(h.records()).toHaveLength(2);
    const before = h.snapshot();
    const overBudget = {
      ...commitInput(),
      projections: Array.from({ length: 58 }, (_, i) => ({
        projectionName: "contentItem.budget",
        itemId: uuid(i + 2),
        sort: instant,
        data: {},
      })),
    };
    await expect(h.factory(scope, new Date(instant)).unitOfWork.commit(overBudget)).rejects.toThrow(
      "60 actions",
    );
    expect(h.snapshot()).toEqual(before);
  });

  it("moves exact sort and partition keys, and leaves no phantom duplicate rows", async () => {
    const h = harness(adapter);
    const first = commitInput();
    const row = { projectionName: "contentItem.test", itemId: uuid(1), sort: instant, data: {} };
    await h.factory(scope, new Date(instant)).unitOfWork.commit({ ...first, projections: [row] });
    const moved = { ...row, sort: "2026-11-01T00:00:00.000Z" };
    const update = (version: number, projections: CommandCommitInput["projections"]) => ({
      ...first,
      resource: {
        ...first.resource,
        create: false,
        expectedVersion: version - 1,
        next: { ...first.resource.next, version },
      },
      idempotency: { ...first.idempotency!, key: `key-${version}` },
      projections,
    });
    await h
      .factory(scope, new Date(instant))
      .unitOfWork.commit(update(2, [{ ...row, delete: true }, moved]));
    expect(await h.repository.listProjection(row.projectionName)).toEqual([
      { ...moved, sort: `${moved.sort}#${moved.itemId}` },
    ]);
    const relocated = { ...moved, projectionName: "contentItem.relocated" };
    await h
      .factory(scope, new Date(instant))
      .unitOfWork.commit(
        update(3, [
          { ...moved, delete: true },
          relocated,
          { ...relocated, sort: `${relocated.sort}#${relocated.itemId}` },
        ]),
      );
    expect(await h.repository.listProjection(row.projectionName)).toEqual([]);
    expect(await h.repository.listProjection(relocated.projectionName)).toEqual([
      { ...relocated, sort: `${relocated.sort}#${relocated.itemId}` },
    ]);
  });

  it("replays if the winner commits between our lookup and stale decision", async () => {
    const h = harness(adapter);
    await h.run("create", { title: "Draft", body: "Body" });
    let once = false;
    let winner: Awaited<ReturnType<typeof h.run>> | undefined;
    const request = {
      resourceType: "contentItem",
      resourceId: uuid(1),
      commandName: "editDraft",
      input: { expectedVersion: 1, title: "Edited", body: "Body" },
      requestContext: {},
      idempotencyKey: "race",
    };
    const dispatch = createContentDispatch({
      clock: () => new Date(instant),
      persistence: (context, now) => {
        const scoped = h.factory(context, now);
        return {
          ...scoped,
          repository: {
            ...scoped.repository,
            getIdempotency: async (key) => {
              const initial = await scoped.repository.getIdempotency!(key);
              if (!once) {
                once = true;
                winner = await h.dispatch(request, fixtureAuth("author_1"));
              }
              return initial;
            },
          },
        };
      },
    });
    expect(await dispatch(request, fixtureAuth("author_1"))).toEqual(winner);
    expect(winner!.ok).toBe(true);
    expect(h.records()).toHaveLength(2);
  });
});

function commitInput(): CommandCommitInput {
  const state: ResourceState = {
    resourceType: "contentItem",
    resourceId: uuid(1),
    version: 1,
    state: {},
    createdAt: instant,
    updatedAt: instant,
    createdBy: "author_1",
    updatedBy: "author_1",
  };
  return {
    resource: { resourceType: "contentItem", resourceId: uuid(1), create: true, next: state },
    activity: [],
    outbox: [],
    projections: [],
    response: {},
    idempotency: {
      key: "key",
      fingerprint: "fingerprint",
      response: {
        ok: true,
        data: {},
        meta: { requestId: "request", correlationId: "correlation" },
      },
    },
  };
}

describe("transaction composition", () => {
  it("deduplicates physical sort aliases and delete/put pairs, while retaining primary and idempotency conditions", () => {
    const row = { projectionName: "contentItem.list", itemId: uuid(1), sort: instant, data: {} };
    const input = {
      ...commitInput(),
      projections: [{ ...row, delete: true }, row, { ...row, sort: `${instant}#${uuid(1)}` }],
    };
    const plan = prepareTransaction(input, scope, new Date(instant), "test");
    expect(plan.items).toHaveLength(4);
    expect(plan.commit.projections).toEqual([{ ...row, sort: `${instant}#${uuid(1)}` }]);
    expect(plan.items[0]!.Put!.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(plan.items[plan.idempotencyIndex]!.Put!.ConditionExpression).toBe(
      "attribute_not_exists(PK) OR expiresAt <= :now",
    );
    const update = {
      ...commitInput(),
      resource: { ...commitInput().resource, create: false, expectedVersion: 1 },
    };
    expect(
      prepareTransaction(update, scope, new Date(instant), "test").items[0]!.Put,
    ).toMatchObject({
      ConditionExpression: "#version = :expectedVersion",
      ExpressionAttributeValues: { ":expectedVersion": { N: "1" } },
    });
  });

  it("rejects conflicting projection puts, duplicate activity keys, and mismatched scopes", () => {
    const row = { projectionName: "contentItem.list", itemId: uuid(1), sort: instant, data: {} };
    expect(() =>
      prepareTransaction(
        { ...commitInput(), projections: [row, { ...row, data: { different: true } }] },
        scope,
        new Date(instant),
        "test",
      ),
    ).toThrow("Conflicting projection");
    expect(() =>
      prepareTransaction(
        commitInput(),
        { ...scope, subject: "author_2" },
        new Date(instant),
        "test",
      ),
    ).toThrow("scope");
    const activity = {
      activityId: "activity",
      resourceType: "contentItem",
      resourceId: uuid(1),
      activityType: "created",
      title: "Created",
      correlationId: "correlation",
      occurredAt: instant,
    };
    expect(() =>
      prepareTransaction(
        { ...commitInput(), activity: [activity, activity] },
        scope,
        new Date(instant),
        "test",
      ),
    ).toThrow("Duplicate physical");
  });

  it("allows exactly 60 distinct actions and rejects 61 before sending", async () => {
    const input = {
      ...commitInput(),
      projections: Array.from({ length: 57 }, (_, i) => ({
        projectionName: "contentItem.list",
        itemId: uuid(i + 2),
        sort: instant,
        data: {},
      })),
    };
    expect(prepareTransaction(input, scope, new Date(instant), "test").items).toHaveLength(60);
    const client = new TransactionClient();
    const factory = createDynamoPersistence({ client, tableName: "test" });
    await expect(
      factory(scope, new Date(instant)).unitOfWork.commit({
        ...input,
        projections: [...input.projections, { ...input.projections[0]!, itemId: uuid(999) }],
      }),
    ).rejects.toThrow("60 actions");
    expect(client.transactions).toHaveLength(0);
  });

  it("maps service failures without exposing raw errors or retrying a mutation", async () => {
    const h = harness("dynamo");
    h.client.failure = new Error("sensitive SDK details");
    const result = await h.run("create", { title: "Draft", body: "Body" });
    expect(result).toMatchObject({ ok: false, error: { code: "runtime.unavailable" } });
    expect(JSON.stringify(result)).not.toContain("sensitive");
    expect(h.client.transactions).toHaveLength(1);
    expect(h.client.items.size).toBe(0);
  });

  it("recovers the original response after an ambiguous successful DynamoDB commit", async () => {
    const client = new TransactionClient();
    const dispatch = createContentDispatch({
      clock: () => new Date(instant),
      persistence: createDynamoPersistence({
        tableName: "test",
        client: {
          send: async (command) => {
            const result = await client.send(command);
            if (command instanceof TransactWriteItemsCommand) throw new Error("Lost response");
            return result;
          },
        },
      }),
    });
    const request = {
      resourceType: "contentItem",
      commandName: "create",
      input: { title: "Draft", body: "Body" },
      idempotencyKey: "ambiguous",
      requestContext: {},
    };
    const result = await dispatch(request, fixtureAuth("author_1"));
    expect(result.ok).toBe(true);
    expect(await dispatch(request, fixtureAuth("author_1"))).toEqual(result);
    expect(client.transactions).toHaveLength(1);
  });
});
