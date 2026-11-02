import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { defineAtomicRecord, JawStackRuntimeError, type JawStackEvent } from "@jawstack/core";
import { createDynamoWorkflow, projectionKey, toProjectionItem } from "../src/index";
import { WorkflowClient, itemKey } from "./support/workflow-client";
import { auth, fixture, initial, receipt } from "./support/workflow";

describe.each(["memory", "dynamo"] as const)("%s public workflow parity", (backend) => {
  const harness = (options: Parameters<typeof fixture>[1] = {}) => {
    const client = new WorkflowClient();
    const h = fixture(backend, { ...options, client });
    const outbox = (): JawStackEvent[] =>
      h.memory ? h.memory.store.outbox : client.decoded("OUTBOX_EVENT").map((row) => row.event);
    return { ...h, client, outbox };
  };
  it("commits every category, replays normalized input with original metadata, and detaches typed reads", async () => {
    const h = harness();
    const first = await h.run();
    expect(first).toMatchObject({ ok: true });
    expect(await h.run("key", "  Draft  ")).toEqual(first);
    expect(h.decisions()).toBe(1);
    const row = await h.runtime.repository.getState("document", "doc_1");
    (row!.state as { title: string }).title = "local mutation";
    expect((await h.runtime.repository.getState("document", "doc_1"))?.state).toEqual({
      title: "Draft",
    });
    const value = await h.runtime.records.get(receipt, "doc_1#1");
    expect(value).toEqual({ id: "doc_1", version: 1 });
    value!.version = 99;
    expect(await h.runtime.records.get(receipt, "doc_1#1")).toEqual({ id: "doc_1", version: 1 });
    expect(
      (await h.runtime.queries.queryActivity({ resourceType: "document", resourceId: "doc_1" }))
        .items,
    ).toHaveLength(1);
    expect(h.outbox()).toHaveLength(1);
    await h.runtime.close();
  });
  it("isolates subject and command scopes and rejects conflicting input/targets", async () => {
    const h = harness();
    await h.run();
    expect(await h.run("key", "Other")).toMatchObject({
      ok: false,
      error: { code: "idempotency.conflict" },
    });
    expect(await h.run("key", "Draft", "doc_2")).toMatchObject({
      ok: false,
      error: { code: "idempotency.conflict" },
    });
    expect(await h.run("key", "Two", "doc_2", { ...auth(), subject: "other" })).toMatchObject({
      ok: true,
    });
    expect(
      await h.runtime.dispatch(h.request("key", "Edited", "doc_1", "edit"), auth()),
    ).toMatchObject({ ok: true });
    await h.runtime.close();
  });
  it("rechecks authorization before a cached response and ignores opaque ingress context", async () => {
    const h = harness();
    const request = h.request();
    Object.defineProperty(request, "requestContext", {
      get: () => {
        throw new Error("opaque");
      },
    });
    expect(await h.runtime.dispatch(request, auth())).toMatchObject({ ok: true });
    expect(await h.run("key", "Draft", "doc_1", { ...auth(), roles: [] })).toMatchObject({
      ok: false,
      error: { code: "auth.forbidden" },
    });
    expect(await h.run("key", "Draft", "doc_1", { ...auth(), tenantId: "tenant" })).toMatchObject({
      ok: false,
      error: { code: "auth.forbidden" },
    });
    expect(h.decisions()).toBe(1);
    await h.runtime.close();
  });
  it("converges concurrent equivalent retries without duplicate contributions", async () => {
    const h = harness();
    const results = await Promise.all(Array.from({ length: 8 }, () => h.run()));
    expect(results.every((result) => result.ok)).toBe(true);
    for (const result of results) expect(result).toEqual(results[0]);
    expect(h.outbox()).toHaveLength(1);
    expect(
      (await h.runtime.queries.queryActivity({ resourceType: "document", resourceId: "doc_1" }))
        .items,
    ).toHaveLength(1);
    await h.runtime.close();
  });
  it("conditionally replaces a physically retained row at the exact logical TTL", async () => {
    const h = harness();
    const first = await h.run();
    h.advance(604800000 - 1);
    expect(await h.run()).toEqual(first);
    h.advance(1);
    expect(await h.run("key", "Fresh", "doc_2")).toMatchObject({ ok: true });
    expect(await h.run("key", "Fresh", "doc_2")).not.toEqual(first);
    expect((await h.runtime.repository.getState("document", "doc_1"))?.version).toBe(1);
    if (backend === "dynamo") expect(h.client.decoded("IDEMPOTENCY_RECORD")).toHaveLength(1);
    await h.runtime.close();
  });
  it("arbitrates concurrent expired replacements", async () => {
    const h = harness();
    await h.run();
    h.advance(604800000);
    const results = await Promise.all([h.run("key", "One", "doc_2"), h.run("key", "Two", "doc_3")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([
      { error: { code: "idempotency.conflict" } },
    ]);
    expect(h.outbox()).toHaveLength(2);
    await h.runtime.close();
  });
  it("rolls back primary/activity/outbox/projections/idempotency on an auxiliary-only conflict", async () => {
    const h = harness({
      change: (input) => ({
        ...input,
        contribute: ({ commit }) => ({
          records: [receipt.create({ id: commit.resource.resourceId, version: 1 })],
        }),
      }),
    });
    await h.run();
    const before = structuredClone(h.client.items);
    expect(
      await h.runtime.dispatch(h.request("edit", "Edited", "doc_1", "edit"), auth()),
    ).toMatchObject({ ok: false, error: { code: "resource.conflict" } });
    expect((await h.runtime.repository.getState("document", "doc_1"))?.version).toBe(1);
    expect(
      (await h.runtime.queries.queryProjection({ projectionName: "document.list" })).items.map(
        (row) => row.sort,
      ),
    ).toEqual(["v1#doc_1"]);
    expect(
      (await h.runtime.queries.queryActivity({ resourceType: "document", resourceId: "doc_1" }))
        .items,
    ).toHaveLength(1);
    expect(h.outbox()).toHaveLength(1);
    expect(h.client.items).toEqual(before);
    await h.runtime.close();
  });
  it("moves only exact projection keys and keyset-pages a registered namespace", async () => {
    const h = harness();
    await h.run();
    const extra = {
      projectionName: "document.list",
      itemId: "doc_1",
      sort: "extra#doc_1",
      data: { title: "Extra" },
    };
    if (h.memory) {
      const key = projectionKey({ ...extra, resourceType: "document" });
      h.memory.store.projections.set(JSON.stringify(key), extra);
    } else
      h.client.put(
        toProjectionItem({
          ...extra,
          resourceType: "document",
          resourceId: "doc_1",
          updatedAt: initial,
        }),
      );
    await h.runtime.dispatch(h.request("edit", "Edited", "doc_1", "edit"), auth());
    const first = await h.runtime.queries.queryProjection({
      projectionName: "document.list",
      limit: 1,
    });
    expect(first.items[0]?.sort).toBe("extra#doc_1");
    expect(first.nextCursor).toBeTruthy();
    const second = await h.runtime.queries.queryProjection({
      projectionName: "document.list",
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((row) => row.sort)).toEqual(["v2#doc_1"]);
    await expect(
      h.runtime.queries.queryProjection({ projectionName: "document.failures" }),
    ).rejects.toMatchObject({ code: "auth.forbidden" });
    await h.runtime.close();
  });
  it("collects durably, authorizes replay, deduplicates requests and completes before the marker", async () => {
    const effects: string[] = [];
    const h = harness({
      runtime: {
        bind: () => ({
          process: {
            handle: () => {
              effects.push("business");
            },
          },
        }),
      },
    });
    await h.runtime.delivery.collect("process", h.original);
    const page = await h.runtime.operations.inspect(auth());
    if (!("items" in page)) throw new Error();
    const id = page.items[0]!.id,
      requestId = randomUUID();
    await expect(
      h.runtime.operations.replay(id, { ...auth(), roles: [] }, requestId),
    ).rejects.toMatchObject({ code: "auth.forbidden" });
    const queued = await h.runtime.operations.replay(id, auth(), requestId);
    expect(await h.runtime.operations.replay(id, auth(), requestId)).toEqual(queued);
    expect(h.outbox()).toHaveLength(1);
    const event = h.outbox()[0]!;
    expect(await h.runtime.delivery.handle("process", event)).toEqual({ status: "processed" });
    expect(await h.runtime.operations.inspect(auth(), { id })).toMatchObject({
      status: "resolved",
      generation: 1,
    });
    expect(await h.runtime.delivery.handle("process", event)).toEqual({ status: "duplicate" });
    expect(effects).toEqual(["business"]);
    await expect(
      h.runtime.delivery.handle("process", {
        ...event,
        payload: { ...(event.payload as object), title: "forged" },
      }),
    ).rejects.toMatchObject({ code: "command.rejected" });
    await h.runtime.close();
  });
  it("leaves application-policy failures inspectable but not generically replayable", async () => {
    const h = harness({
      change: (input) => ({ ...input, consumers: { process: { recovery: "application" } } }),
    });
    await h.runtime.delivery.collect("process", h.original);
    const page = await h.runtime.operations.inspect(auth());
    if (!("items" in page)) throw new Error();
    await expect(
      h.runtime.operations.replay(page.items[0]!.id, auth(), randomUUID()),
    ).rejects.toMatchObject({ code: "command.rejected" });
    expect(h.outbox()).toHaveLength(0);
    await h.runtime.close();
  });
  it("expires processing markers after seven days without locking concurrent handlers", async () => {
    const handle = vi.fn();
    const h = harness({ runtime: { bind: () => ({ process: { handle } }) } });
    await h.runtime.delivery.handle("process", h.original);
    expect(await h.runtime.delivery.handle("process", h.original)).toEqual({ status: "duplicate" });
    h.advance(604800000);
    expect(await h.runtime.delivery.handle("process", h.original)).toEqual({ status: "processed" });
    expect(handle).toHaveBeenCalledTimes(2);
    await h.runtime.close();
  });
});

describe("Dynamo workflow storage faults", () => {
  const harness = () => {
    const client = new WorkflowClient();
    return { ...fixture("dynamo", { client }), client };
  };
  it("constructs without SDK calls, exposes no memory pump, and does not destroy a borrowed client", async () => {
    const h = harness();
    expect(h.client.calls).toEqual([]);
    for (const field of ["store", "drain", "drainUntilIdle", "start"])
      expect(h.runtime).not.toHaveProperty(field);
    await h.runtime.close();
    expect(h.client.calls).toEqual([]);
    expect(await h.run()).toMatchObject({ ok: false, error: { code: "runtime.unavailable" } });
  });
  it("requires explicit client/table, rejects mixed declarations on a shared pair, and allows equivalent API/worker composition", async () => {
    const h = harness(),
      bind = () => ({ process: { handle: () => {} } });
    expect(() =>
      createDynamoWorkflow(h.definition, { bind, client: h.client, tableName: "bad/table" }),
    ).toThrow(/explicit/);
    expect(() =>
      createDynamoWorkflow(h.definition, { bind, client: undefined!, tableName: "table" }),
    ).toThrow(/explicit/);
    const other = fixture("memory", { change: (input) => ({ ...input, name: "different" }) });
    expect(() =>
      createDynamoWorkflow(other.definition, {
        bind,
        client: h.client,
        tableName: "workflow-test",
      }),
    ).toThrow(/different/);
    const worker = createDynamoWorkflow(h.definition, {
      bind,
      client: h.client,
      tableName: "workflow-test",
    });
    expect(h.client.calls).toEqual([]);
    await worker.close();
    await other.runtime.close();
    await h.runtime.close();
  });
  it("does not reserve an unused table after failed binding", async () => {
    const client = new WorkflowClient(),
      h = fixture("memory");
    expect(() =>
      createDynamoWorkflow(h.definition, { client, tableName: "unused", bind: () => ({}) }),
    ).toThrow(/Bindings/);
    const other = fixture("dynamo", { client, change: (input) => ({ ...input, name: "another" }) });
    const runtime = createDynamoWorkflow(other.definition, {
      client,
      tableName: "unused",
      bind: () => ({ process: { handle: () => {} } }),
    });
    expect(client.calls).toEqual([]);
    await h.runtime.close();
    await other.runtime.close();
    await runtime.close();
  });
  it("preserves ordinary business fields named owner and metadata in flat auxiliary rows", async () => {
    const client = new WorkflowClient();
    const record = defineAtomicRecord({
      name: "owned",
      schema: z.strictObject({ id: z.string(), owner: z.string(), metadata: z.boolean() }),
      key: (value) => value.id,
      owner: (value) => ({ resourceType: "document", resourceId: value.id }),
    });
    const h = fixture("dynamo", {
      client,
      change: (input) => ({
        ...input,
        records: [record],
        contribute: ({ commit }) => ({
          records: [
            record.create({
              id: commit.resource.resourceId,
              owner: "business-owner",
              metadata: true,
            }),
          ],
        }),
      }),
    });
    expect(await h.run()).toMatchObject({ ok: true });
    expect(await h.runtime.records.get(record, "doc_1")).toEqual({
      id: "doc_1",
      owner: "business-owner",
      metadata: true,
    });
    expect(Object.keys(client.decoded("APP_OPERATION")[0]!).sort()).toEqual([
      "PK",
      "SK",
      "id",
      "itemKind",
      "metadata",
      "owner",
    ]);
    await h.runtime.close();
  });
  it("rejects an invalid marker clock before a handler effect or SDK lookup", async () => {
    const client = new WorkflowClient(),
      handle = vi.fn();
    const h = fixture("dynamo", {
      client,
      runtime: { clock: () => new Date(NaN), bind: () => ({ process: { handle } }) },
    });
    await expect(h.runtime.delivery.handle("process", h.original)).rejects.toMatchObject({
      code: "command.rejected",
    });
    expect(handle).not.toHaveBeenCalled();
    expect(client.calls).toEqual([]);
    await h.runtime.close();
  });
  it("recovers a successful transaction with a lost response without rerunning the decision", async () => {
    const h = harness();
    h.client.after = (command) => {
      if (command instanceof TransactWriteItemsCommand) throw new Error("private network details");
    };
    expect(await h.run()).toMatchObject({ ok: true });
    expect(h.decisions()).toBe(1);
    expect(h.client.transactions).toHaveLength(1);
    expect(h.client.decoded("ACTIVITY")).toHaveLength(1);
    expect(
      h.client.calls
        .filter((call) => call instanceof GetItemCommand)
        .every((call) => call.input.ConsistentRead),
    ).toBe(true);
    await h.runtime.close();
  });
  it("reads a late idempotency winner after a stale edit without another decision or state lookup", async () => {
    const h = harness();
    await h.run();
    let armed = true,
      reads = 0,
      winner: Awaited<ReturnType<typeof h.run>> | undefined;
    h.client.after = async (command) => {
      if (command instanceof GetItemCommand && command.input.Key?.SK?.S === "STATE") {
        reads++;
        if (armed) {
          armed = false;
          winner = await h.runtime.dispatch(
            { ...h.request("edit", "Edited", "doc_1", "edit"), requestId: "winner" },
            auth(),
          );
        }
      }
    };
    const result = await h.runtime.dispatch(
      { ...h.request("edit", "Edited", "doc_1", "edit"), requestId: "loser" },
      auth(),
    );
    expect(result).toEqual(winner);
    expect(result.meta.requestId).toBe("winner");
    expect(h.decisions()).toBe(3); // create, winning edit, stale edit; never a fourth decision
    expect(reads).toBe(4); // executor + corruption-preflight read for each edit; none for replay
    expect(h.client.decoded("ACTIVITY")).toHaveLength(2);
    await h.runtime.close();
  });
  it("converges concurrent collectors and uncertain failure commits through the shared CAS protocol", async () => {
    const h = harness();
    h.client.after = (command) => {
      if (command instanceof TransactWriteItemsCommand) throw new Error("lost ledger response");
    };
    await Promise.all(
      Array.from({ length: 6 }, () => h.runtime.delivery.collect("process", h.original)),
    );
    expect(h.client.decoded("APP_FAILURE")).toHaveLength(1);
    expect(h.client.decoded("APP_FAILURE")[0]?.version).toBe(2);
    expect(h.client.decoded("WORKER_IDEMPOTENCY")).toHaveLength(1);
    expect(h.client.decoded("PROJECTION_ITEM")).toHaveLength(1);
    await h.runtime.close();
  });
  it("does not mark a business effect as delivered when recovery completion is unavailable", async () => {
    const client = new WorkflowClient();
    let effects = 0,
      blocked = true;
    const h = fixture("dynamo", {
      client,
      runtime: {
        bind: () => ({
          process: {
            handle: () => {
              if (effects) return "ignored";
              effects++;
            },
          },
        }),
      },
    });
    await h.runtime.delivery.collect("process", h.original);
    const id = client.decoded("APP_FAILURE")[0]!.id;
    await h.runtime.operations.replay(id, auth(), randomUUID());
    const wire = client.decoded("OUTBOX_EVENT")[0]!.event;
    client.before = (command) => {
      if (
        blocked &&
        command instanceof TransactWriteItemsCommand &&
        command.input.TransactItems?.[0]?.Put?.Item?.resolvedGeneration?.N === "1"
      )
        throw new Error("completion unavailable");
    };
    await expect(h.runtime.delivery.handle("process", wire)).rejects.toMatchObject({
      code: "runtime.unavailable",
    });
    expect(effects).toBe(1);
    expect(client.decoded("WORKER_IDEMPOTENCY").some((row) => row.workerName === "process")).toBe(
      false,
    );
    blocked = false;
    expect(await h.runtime.delivery.handle("process", wire)).toEqual({ status: "ignored" });
    expect(await h.runtime.operations.inspect(auth(), { id })).toMatchObject({
      status: "resolved",
    });
    expect(effects).toBe(1);
    await h.runtime.close();
  });
  it.each(["TimeoutError", "ConditionalCheckFailedException", "TransactionCanceledException"])(
    "does not guess a winner from an unclassified %s",
    async (name) => {
      const h = harness();
      h.client.before = (command) => {
        if (command instanceof TransactWriteItemsCommand)
          throw Object.assign(new Error("secret diagnostics"), { name });
      };
      const result = await h.run();
      expect(result).toMatchObject({ ok: false, error: { code: "runtime.unavailable" } });
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(h.decisions()).toBe(1);
      expect(h.client.transactions).toHaveLength(1);
      expect(h.client.items.size).toBe(0);
      await h.runtime.close();
    },
  );
  it.each(["resource", "idempotency", "projection", "record", "marker", "failure"] as const)(
    "rejects stored %s corruption before serving or publishing",
    async (kind) => {
      const h = harness();
      await h.run();
      if (kind === "marker") await h.runtime.delivery.handle("process", h.original);
      if (kind === "failure") await h.runtime.delivery.collect("process", h.original);
      const kinds = {
        resource: "RESOURCE_STATE",
        idempotency: "IDEMPOTENCY_RECORD",
        projection: "PROJECTION_ITEM",
        record: "APP_OPERATION",
        marker: "WORKER_IDEMPOTENCY",
        failure: "APP_FAILURE",
      };
      const item = [...h.client.items.values()].find((row) => row.itemKind?.S === kinds[kind])!;
      h.client.put({ ...item, tenantId: { S: "foreign" } });
      const before = structuredClone(h.client.items);
      if (kind === "resource")
        expect(
          await h.runtime.dispatch(h.request("edit", "Edit", "doc_1", "edit"), auth()),
        ).toMatchObject({ ok: false, error: { code: "resource.invalid_state" } });
      if (kind === "idempotency") {
        h.advance(604800000);
        expect(await h.run("key", "New", "doc_2")).toMatchObject({
          ok: false,
          error: { code: "resource.invalid_state" },
        });
      }
      if (kind === "projection")
        await expect(
          h.runtime.queries.queryProjection({ projectionName: "document.list" }),
        ).rejects.toMatchObject({ code: "resource.invalid_state" });
      if (kind === "record")
        await expect(h.runtime.records.get(receipt, "doc_1#1")).rejects.toMatchObject({
          code: "resource.invalid_state",
        });
      if (kind === "marker")
        await expect(h.runtime.delivery.handle("process", h.original)).rejects.toMatchObject({
          code: "resource.invalid_state",
        });
      if (kind === "failure")
        await expect(h.runtime.operations.inspect(auth())).resolves.toHaveProperty("items");
      if (kind === "failure") {
        const id = unmarshall(item).id;
        await expect(h.runtime.operations.inspect(auth(), { id })).rejects.toMatchObject({
          code: "resource.invalid_state",
        });
      }
      expect(h.client.items).toEqual(before);
      await h.runtime.close();
    },
  );
  it.each(["itemKind", "PK", "version", "extra"])(
    "does not strip invalid resource %s",
    async (field) => {
      const h = harness();
      await h.run();
      const item = [...h.client.items.values()].find(
        (row) => row.itemKind?.S === "RESOURCE_STATE",
      )!;
      h.client.items.set(itemKey(item), {
        ...item,
        [field]: field === "version" ? { N: "0" } : { S: "wrong" },
      });
      await expect(h.runtime.repository.getState("document", "doc_1")).rejects.toMatchObject({
        code: "resource.invalid_state",
      });
      await h.runtime.close();
    },
  );
  it.each(["expiresAt", "resourceId", "subject", "statusCode", "response"])(
    "validates expired idempotency %s before replacement",
    async (field) => {
      const h = harness();
      await h.run();
      h.advance(604800000);
      const item = [...h.client.items.values()].find(
        (row) => row.itemKind?.S === "IDEMPOTENCY_RECORD",
      )!;
      h.client.put({
        ...item,
        [field]:
          field === "statusCode"
            ? { N: "500" }
            : field === "response"
              ? { M: { ok: { BOOL: false } } }
              : { S: field === "subject" ? "foreign" : "invalid#identity" },
      });
      const before = h.client.transactions.length;
      expect(await h.run("key", "New", "doc_2")).toMatchObject({
        ok: false,
        error: { code: "resource.invalid_state" },
      });
      expect(h.client.transactions).toHaveLength(before);
      await h.runtime.close();
    },
  );
  it("rejects corrupt preexisting replaceable projections before sending a command transaction", async () => {
    const h = harness();
    h.client.put(
      marshall({
        PK: "PROJ#document#list",
        SK: "v1#doc_1",
        itemKind: "PROJECTION_ITEM",
        resourceType: "document",
        resourceId: "doc_1",
        projectionName: "document.list",
        itemId: "other",
        sort: "v1#doc_1",
        data: {},
        updatedAt: initial,
      }),
    );
    expect(await h.run()).toMatchObject({ ok: false, error: { code: "resource.invalid_state" } });
    expect(h.client.transactions).toHaveLength(0);
    await h.runtime.close();
  });
  it("rejects an oversized existing projection-delete set before sending any write", async () => {
    const client = new WorkflowClient();
    const rows = Array.from({ length: 24 }, (_, i) => ({
      projectionName: "document.list",
      itemId: "doc_1",
      sort: `old${i}#doc_1`,
      data: { title: "x".repeat(180 * 1024) },
    }));
    for (const row of rows)
      client.put(
        toProjectionItem({
          ...row,
          resourceType: "document",
          resourceId: "doc_1",
          updatedAt: initial,
        }),
      );
    const h = fixture("dynamo", {
      client,
      change: (input) => ({
        ...input,
        contribute: () => ({
          projections: rows.map((row) => ({ ...row, data: {}, delete: true })),
        }),
      }),
    });
    const before = structuredClone(client.items);
    expect(await h.run()).toMatchObject({ ok: false, error: { code: "command.rejected" } });
    expect(client.transactions).toHaveLength(0);
    expect(client.items).toEqual(before);
    await h.runtime.close();
  });
  it("retains pending reconciliation without acknowledging when durable history is unavailable", async () => {
    const h = harness();
    h.client.before = (command) => {
      if (
        command instanceof TransactWriteItemsCommand &&
        command.input.TransactItems?.[0]?.Put?.Item?.version?.N === "2"
      )
        throw new Error("unavailable");
    };
    await expect(h.runtime.delivery.collect("process", h.original)).rejects.toMatchObject({
      code: "runtime.unavailable",
    });
    expect(h.client.decoded("APP_FAILURE")[0]?.collections[0].resolution).toBe("pending");
    expect(h.client.decoded("WORKER_IDEMPOTENCY")).toHaveLength(0);
    delete h.client.before;
    await h.runtime.delivery.collect("process", h.original);
    expect(h.client.decoded("WORKER_IDEMPOTENCY")).toHaveLength(1);
    await h.runtime.close();
  });
  it("atomically rejects a replay outbox collision without advancing history/projection", async () => {
    const h = harness();
    await h.runtime.delivery.collect("process", h.original);
    const id = h.client.decoded("APP_FAILURE")[0]!.id;
    const before = structuredClone(h.client.items);
    h.client.before = (command) => {
      if (command instanceof TransactWriteItemsCommand) {
        const outbox = command.input.TransactItems?.find(
          (write) => write.Put?.Item?.itemKind?.S === "OUTBOX_EVENT",
        )?.Put?.Item;
        if (outbox) h.client.put(outbox);
      }
    };
    await expect(h.runtime.operations.replay(id, auth(), randomUUID())).rejects.toMatchObject({
      code: "runtime.unavailable",
    });
    expect(h.client.decoded("APP_FAILURE")[0]?.recoveries).toEqual([]);
    for (const [key, value] of before) expect(h.client.items.get(key)).toEqual(value);
    await h.runtime.close();
  });
  it("records business then ledger then marker; retries a lost marker response via strong read", async () => {
    const order: string[] = [],
      client = new WorkflowClient();
    const h = fixture("dynamo", {
      client,
      runtime: {
        bind: () => ({
          process: {
            handle: () => {
              order.push("business");
            },
          },
        }),
      },
    });
    await h.runtime.delivery.collect("process", h.original);
    const id = client.decoded("APP_FAILURE")[0]!.id;
    await h.runtime.operations.replay(id, auth(), randomUUID());
    const wire = client.decoded("OUTBOX_EVENT")[0]!.event;
    client.after = (command) => {
      if (command instanceof TransactWriteItemsCommand) order.push("ledger");
      if (command instanceof PutItemCommand) {
        order.push("marker");
        throw new Error("lost marker response");
      }
    };
    expect(await h.runtime.delivery.handle("process", wire)).toEqual({ status: "processed" });
    expect(order).toEqual(["business", "ledger", "marker"]);
    expect(await h.runtime.delivery.handle("process", wire)).toEqual({ status: "duplicate" });
    await h.runtime.close();
  });
  it("authenticates forged recovery before any marker or effect even after a valid marker exists", async () => {
    const h = harness();
    await h.runtime.delivery.collect("process", h.original);
    const id = h.client.decoded("APP_FAILURE")[0]!.id;
    await h.runtime.operations.replay(id, auth(), randomUUID());
    const wire = h.client.decoded("OUTBOX_EVENT")[0]!.event;
    await h.runtime.delivery.handle("process", wire);
    h.client.calls = [];
    await expect(
      h.runtime.delivery.handle("process", {
        ...wire,
        payload: { ...wire.payload, title: "forged" },
      }),
    ).rejects.toMatchObject({ code: "command.rejected" });
    expect(
      h.client.calls.some(
        (command) =>
          command instanceof GetItemCommand && command.input.Key?.PK?.S?.startsWith("WORKER#"),
      ),
    ).toBe(false);
    expect(
      h.client.calls.some(
        (command) =>
          command instanceof QueryCommand ||
          command instanceof PutItemCommand ||
          command instanceof TransactWriteItemsCommand,
      ),
    ).toBe(false);
    await h.runtime.close();
  });
  it("preserves explicitly structured unavailable errors", async () => {
    const h = harness();
    h.client.before = () => {
      throw new JawStackRuntimeError("runtime.unavailable", "Storage offline.");
    };
    expect(await h.run()).toMatchObject({
      ok: false,
      error: { code: "runtime.unavailable", message: "Storage offline." },
    });
    await h.runtime.close();
  });
});
