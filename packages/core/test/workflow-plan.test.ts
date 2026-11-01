import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import {
  createWorkflowCommitPlanner,
  defineAtomicRecord,
  workflowCommitLimits,
  workflowRecordKeys,
  type AtomicRecordCreate,
  type AtomicRecordDefinition,
  type CommandCommitInput,
  type WorkflowCommitContributor,
  type WorkflowCommitPlan,
  type WorkflowCommitPlanner,
} from "../src/index";

const now = "2026-11-01T12:00:00.000Z";
const scope = { resourceType: "document", commandName: "create", subject: "user_1" };
const invocation = () => ({ scope: { ...scope }, now });
function input(): CommandCommitInput {
  return {
    resource: {
      resourceType: "document",
      resourceId: "doc_1",
      create: true,
      next: {
        resourceType: "document",
        resourceId: "doc_1",
        version: 1,
        state: { title: "Draft" },
        createdAt: now,
        updatedAt: now,
        createdBy: "user_1",
        updatedBy: "user_1",
      },
    },
    activity: [
      {
        activityId: "act_1",
        resourceType: "document",
        resourceId: "doc_1",
        activityType: "created",
        title: "Created",
        correlationId: "corr_1",
        occurredAt: now,
      },
    ],
    outbox: [
      {
        envelopeVersion: 1,
        eventId: "evt_1",
        eventType: "document.created",
        schemaVersion: 1,
        source: "documents",
        resourceType: "document",
        resourceId: "doc_1",
        occurredAt: now,
        correlationId: "corr_1",
        payload: { title: "Draft" },
      },
    ],
    projections: [
      { projectionName: "document.list", itemId: "doc_1", sort: now, data: { title: "Draft" } },
    ],
    response: { id: "doc_1" },
    idempotency: {
      key: "key_1",
      fingerprint: "original-core-fingerprint",
      response: {
        ok: true,
        data: { id: "doc_1" },
        meta: { requestId: "req_1", correlationId: "corr_1" },
      },
    },
  };
}
const receipt = (name = "commandReceipt") =>
  defineAtomicRecord({
    name,
    schema: z.strictObject({
      kind: z.literal("receipt"),
      resourceId: z.string(),
      text: z.string(),
    }),
    key: (value) => value.resourceId,
    owner: (value) => ({ resourceType: "document", resourceId: value.resourceId }),
  });
const value = { kind: "receipt" as const, resourceId: "doc_1", text: "accepted" };
function planner(
  options: Partial<Parameters<typeof createWorkflowCommitPlanner>[0]> = {},
): WorkflowCommitPlanner {
  return createWorkflowCommitPlanner({
    workflowName: "documents",
    source: "documents",
    idempotencyTtlSeconds: 604800,
    ...options,
  });
}
const plan = (commit = input()) => planner().plan(invocation(), commit);

describe("registered atomic records", () => {
  it("is typed, detached, registered by identity and owned by the command root", () => {
    const record = receipt();
    expectTypeOf(record.create).parameter(0).toEqualTypeOf<typeof value>();
    const original = { ...value };
    const contribution = record.create(original);
    original.text = "changed";
    const p = planner({ records: [record], contribute: () => ({ records: [contribution] }) });
    const result = p.plan(invocation(), input());
    expect(result.actions.at(-1)).toMatchObject({
      kind: "record",
      collection: "commandReceipt",
      key: { partition: "OPS#commandReceipt", sort: "doc_1" },
      condition: { kind: "absent" },
      value,
    });
    expect(() =>
      planner({ contribute: () => ({ records: [contribution] }) }).plan(invocation(), input()),
    ).toThrow(/Unregistered/);
    const other = receipt();
    expect(() =>
      planner({ records: [other], contribute: () => ({ records: [contribution] }) }).plan(
        invocation(),
        input(),
      ),
    ).toThrow(/Unregistered/);
    expect(() =>
      planner({
        records: [record],
        contribute: () => ({ records: [record.create({ ...value, resourceId: "foreign" })] }),
      }).plan(invocation(), input()),
    ).toThrow(/owner/);
  });
  it("rejects duplicate/forged definitions and cast-forged create values", () => {
    expect(() => planner({ records: [receipt(), receipt()] })).toThrow(/duplicate/);
    expect(() => planner({ records: [{} as AtomicRecordDefinition] })).toThrow(/Invalid/);
    expect(() =>
      planner({ contribute: () => ({ records: [{} as AtomicRecordCreate] }) }).plan(
        invocation(),
        input(),
      ),
    ).toThrow(/forged/);
  });
  it.each(["outbox", "jawstack.custom", "failure", "bad#name", "x".repeat(101), ""])(
    "rejects invalid/reserved collection %s",
    (name) => expect(() => receipt(name)).toThrow(/collection/),
  );
  it("enforces strict object schemas even when the caller supplies a stripping schema", () => {
    const record = defineAtomicRecord({
      name: "strict",
      schema: z.object({ id: z.string() }),
      key: (v) => v.id,
      owner: (v) => ({ resourceType: "document", resourceId: v.id }),
    });
    expect(() => record.create({ id: "doc_1", extra: true } as { id: string })).toThrow(/schema/);
    expect(() =>
      defineAtomicRecord({
        name: "invalid",
        schema: z.string(),
        key: () => "x",
        owner: () => ({ resourceType: "document", resourceId: "doc_1" }),
      }),
    ).toThrow(/object schema/);
  });
  it.each(["PK", "SK", "itemKind", "tenantId"])("rejects reserved data field %s", (field) => {
    const record = defineAtomicRecord({
      name: "metadata",
      schema: z.strictObject({ [field]: z.string() }),
      key: () => "key",
      owner: () => ({ resourceType: "document", resourceId: "doc_1" }),
    });
    expect(() => record.create({ [field]: "unsafe" })).toThrow(/metadata/);
  });
  it.each(["", "x".repeat(1025), "\ud800"])("rejects invalid logical record keys", (key) => {
    const record = defineAtomicRecord({
      name: "keyed",
      schema: z.strictObject({ id: z.string() }),
      key: () => key,
      owner: () => ({ resourceType: "document", resourceId: "doc_1" }),
    });
    expect(() =>
      planner({
        records: [record],
        contribute: () => ({ records: [record.create({ id: "doc_1" })] }),
      }).plan(invocation(), input()),
    ).toThrow(/key bounds/);
  });
  it("accepts a 1024-byte UTF-8 key and rejects duplicate immutable record writes", () => {
    const record = defineAtomicRecord({
      name: "keyed",
      schema: z.strictObject({ id: z.string() }),
      key: () => "\u00e9".repeat(512),
      owner: () => ({ resourceType: "document", resourceId: "doc_1" }),
    });
    const create = record.create({ id: "doc_1" });
    expect(
      planner({ records: [record], contribute: () => ({ records: [create] }) })
        .plan(invocation(), input())
        .actions.at(-1)?.key.sort,
    ).toHaveLength(512);
    expect(() =>
      planner({ records: [record], contribute: () => ({ records: [create, create] }) }).plan(
        invocation(),
        input(),
      ),
    ).toThrow(/Duplicate physical/);
  });
  it("revalidates schema output and rejects non-idempotent transformations", () => {
    const record = defineAtomicRecord({
      name: "unstable",
      schema: z.strictObject({ n: z.number().transform((n) => n + 1) }),
      key: () => "key",
      owner: () => ({ resourceType: "document", resourceId: "doc_1" }),
    });
    expect(() =>
      planner({
        records: [record],
        contribute: () => ({ records: [record.create({ n: 1 })] }),
      }).plan(invocation(), input()),
    ).toThrow(/revalidation/);
  });
  it("rejects asynchronous key/owner hooks without leaving rejected promises unobserved", () => {
    for (const hook of ["key", "owner"] as const) {
      const record = defineAtomicRecord({
        name: "syncOnly",
        schema: z.strictObject({ id: z.string() }),
        key: () => "key",
        owner: () => ({ resourceType: "document", resourceId: "doc_1" }),
        [hook]: async () => {
          throw new Error("invalid async hook");
        },
      } as unknown as Parameters<typeof defineAtomicRecord<{ id: string }>>[0]);
      expect(() =>
        planner({
          records: [record],
          contribute: () => ({ records: [record.create({ id: "doc_1" })] }),
        }).plan(invocation(), input()),
      ).toThrow(/synchronous/);
    }
  });
});

describe("pure workflow commit planning", () => {
  it("retains successful response/fingerprint and requires absent immutable keys", () => {
    const result = plan();
    expect(result.actions.map((a) => a.kind)).toEqual([
      "resource",
      "activity",
      "outbox",
      "projection",
      "idempotency",
    ]);
    for (const action of result.actions.filter((a) =>
      ["resource", "activity", "outbox"].includes(a.kind),
    ))
      expect(action).toHaveProperty("condition", { kind: "absent" });
    expect(result.actions.at(-1)).toMatchObject({
      kind: "idempotency",
      condition: { kind: "absentOrExpired", nowSeconds: Date.parse(now) / 1000 },
      value: {
        ...input().idempotency,
        ...scope,
        createdAt: now,
        expiresAt: Date.parse(now) / 1000 + 604800,
      },
    });
    const update = input();
    const updated = {
      ...update,
      resource: {
        ...update.resource,
        create: false,
        expectedVersion: 1,
        next: { ...update.resource.next, version: 2 },
      },
    };
    expect(plan(updated).actions[0]).toHaveProperty("condition", {
      kind: "version",
      expectedVersion: 1,
    });
  });
  it("preserves exact event property order and unbounded-by-key-size core fingerprints", () => {
    const commit = input();
    const { payload, ...envelope } = commit.outbox[0]!;
    const event = { payload, ...envelope, actor: { subject: "user_1" } };
    const result = plan({
      ...commit,
      outbox: [event],
      idempotency: { ...commit.idempotency!, fingerprint: "f".repeat(6000) },
    });
    const outbox = result.actions.find((a) => a.kind === "outbox")!;
    expect(JSON.stringify(outbox.value)).toBe(JSON.stringify(event));
  });
  it("coalesces sort aliases and deletes/puts but rejects inconsistent projection puts", () => {
    const commit = input(),
      row = commit.projections[0]!;
    const result = plan({
      ...commit,
      projections: [
        { ...row, delete: true },
        row,
        { ...row, sort: `${now}#doc_1`, delete: false },
        { ...row, delete: true },
      ],
    });
    expect(result.actions.filter((a) => a.kind.startsWith("projection"))).toEqual([
      {
        kind: "projection",
        key: { partition: "PROJ#document#list", sort: `${now}#doc_1` },
        value: { ...row, sort: `${now}#doc_1` },
      },
    ]);
    expect(() =>
      plan({ ...commit, projections: [row, { ...row, data: { title: "other" } }] }),
    ).toThrow(/Conflicting/);
    const moved = plan({
      ...commit,
      projections: [
        { ...row, delete: true },
        { ...row, sort: "later" },
      ],
    });
    expect(
      moved.actions.filter((a) => a.kind.startsWith("projection")).map((a) => a.key.sort),
    ).toEqual([`${now}#doc_1`, "later#doc_1"]);
  });
  it("rejects duplicate activity/outbox creates, not silently coalescing immutable facts", () => {
    const commit = input();
    expect(() => plan({ ...commit, activity: [...commit.activity, ...commit.activity] })).toThrow(
      /Duplicate/,
    );
    expect(() => plan({ ...commit, outbox: [...commit.outbox, ...commit.outbox] })).toThrow(
      /Duplicate/,
    );
  });
  it("provides detached recursively frozen input to contributors and immutable producer-owned output", () => {
    const commit = input(),
      captured = invocation();
    const p = planner({
      contribute: ({ invocation, commit }) => {
        expect(Object.isFrozen(invocation.scope)).toBe(true);
        expect(Object.isFrozen(commit.resource.next.state)).toBe(true);
        return {};
      },
    });
    const result = p.plan(captured, commit);
    captured.scope.subject = "changed";
    (commit.resource.next.state as { title: string }).title = "changed";
    expect(result.scope.subject).toBe("user_1");
    expect(result.actions[0]).toMatchObject({ value: { state: { title: "Draft" } } });
    expect(Object.isFrozen(result.actions[0])).toBe(true);
    expect(p.validate(result)).toBe(result);
    expect(() => p.validate(structuredClone(result))).toThrow(/not produced/);
    expect(() => p.validate({ ...result })).toThrow(/not produced/);
    expect(() => planner().validate(result)).toThrow(/not produced/);
    expectTypeOf(result).toEqualTypeOf<WorkflowCommitPlan>();
    expectTypeOf<{
      schemaVersion: 1;
      workflowName: string;
      actions: [];
    }>().not.toMatchTypeOf<WorkflowCommitPlan>();
  });
  it("rejects promise, null, unknown or malformed contribution results", () => {
    for (const output of [null, undefined, { writes: [] }, { records: {} }, { projections: {} }])
      expect(() =>
        planner({ contribute: (() => output) as WorkflowCommitContributor }).plan(
          invocation(),
          input(),
        ),
      ).toThrow(/Contributors/);
    expect(() =>
      planner({
        contribute: (async () => {
          throw new Error("async failure");
        }) as unknown as WorkflowCommitContributor,
      }).plan(invocation(), input()),
    ).toThrow(/synchronous/);
    const original = input();
    expect(() =>
      planner({
        contribute: ({ commit }) => {
          (commit.resource.next.state as { title: string }).title = "mutation";
          return {};
        },
      }).plan(invocation(), original),
    ).toThrow();
    expect(original.resource.next.state).toEqual({ title: "Draft" });
  });
  it.each([
    "resource",
    "actor",
    "version",
    "time",
    "response",
    "tenant",
    "eventTarget",
    "eventSource",
    "delivery",
  ])("rejects mismatched %s authority before producing a plan", (which) => {
    const commit = structuredClone(input());
    const bad = commit as unknown as {
      resource: { resourceType: string; next: Record<string, unknown> };
      response: unknown;
      outbox: Record<string, unknown>[];
    };
    if (which === "resource") bad.resource.resourceType = "other";
    if (which === "actor") bad.resource.next.updatedBy = "other";
    if (which === "version") bad.resource.next.version = 2;
    if (which === "time") bad.resource.next.updatedAt = "2026-11-01T12:01:00.000Z";
    if (which === "response") bad.response = "other";
    if (which === "tenant") bad.resource.next.tenantId = "tenant";
    if (which === "eventTarget") bad.outbox[0]!.resourceId = "other";
    if (which === "eventSource") bad.outbox[0]!.source = "other";
    if (which === "delivery") bad.outbox[0]!.payload = { delivery: {} };
    expect(() => plan(commit)).toThrow();
  });
  it("rejects missing/unbounded scope, idempotency and policy without changing legacy APIs", () => {
    for (const key of ["", "x".repeat(201), "unsafe#key", "key\n", "\u00e9"])
      expect(() => plan({ ...input(), idempotency: { ...input().idempotency!, key } })).toThrow();
    const { idempotency: _ignored, ...without } = input();
    void _ignored;
    expect(() => plan(without)).toThrow();
    expect(() => planner({ maxActions: 61 })).toThrow(/policy/);
    expect(() => planner({ idempotencyTtlSeconds: 0 })).toThrow(/policy/);
    expect(() => planner({ idempotencyTtlSeconds: 604801 })).toThrow(/policy/);
    expect(() =>
      planner().plan(
        { ...invocation(), scope: { ...scope, tenantId: "x" } } as unknown as ReturnType<
          typeof invocation
        >,
        input(),
      ),
    ).toThrow();
  });
});

describe("workflow work budgets", () => {
  it("rejects oversized trees before serializing the entire input and counts escaped property bytes", () => {
    const commit = input();
    const oversized = {
      ...commit,
      projections: Array.from({ length: 9 }, (_, i) => ({
        projectionName: "document.list",
        itemId: `item_${i}`,
        sort: now,
        data: { text: "x".repeat(120 * 1024) },
      })),
    };
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      expect(() => plan(oversized)).toThrow(/byte budget/);
      expect(stringify.mock.calls.some(([value]) => value === oversized)).toBe(false);
    } finally {
      stringify.mockRestore();
    }
    expect(() => plan({ ...commit, response: { ["\u0000".repeat(200_000)]: true } })).toThrow(
      /byte budget/,
    );
  });
  it("accepts exactly 60 normalized actions and rejects 61 or a lower configured ceiling", () => {
    const commit = input();
    const projections = Array.from({ length: 56 }, (_, i) => ({
      projectionName: "document.list",
      itemId: `item_${i}`,
      sort: now,
      data: {},
    }));
    expect(plan({ ...commit, projections }).actions).toHaveLength(60);
    expect(() =>
      plan({ ...commit, projections: [...projections, { ...projections[0]!, itemId: "extra" }] }),
    ).toThrow(/action budget/);
    expect(() => planner({ maxActions: 4 }).plan(invocation(), commit)).toThrow(/action budget/);
    expect(
      plan({ ...commit, projections: Array.from({ length: 70 }, () => commit.projections[0]!) })
        .actions,
    ).toHaveLength(5);
  });
  it("enforces per-record bytes even when a put replaces a previously coalesced delete", () => {
    const commit = input(),
      row = commit.projections[0]!;
    expect(() =>
      plan({
        ...commit,
        projections: [
          { ...row, delete: true },
          { ...row, data: { text: "x".repeat(192 * 1024) } },
        ],
      }),
    ).toThrow(/byte budget/);
    const record = receipt();
    expect(() => record.create({ ...value, text: "x".repeat(64 * 1024) })).toThrow(/byte budget/);
  });
  it("enforces aggregate bytes, node/depth budgets and finite JSON before effects", () => {
    const commit = input();
    const projections = Array.from({ length: 9 }, (_, i) => ({
      projectionName: "document.list",
      itemId: `item_${i}`,
      sort: now,
      data: { text: "x".repeat(120 * 1024) },
    }));
    expect(() => plan({ ...commit, projections })).toThrow(/byte budget/);
    for (const invalid of [
      undefined,
      NaN,
      Infinity,
      1n,
      () => {},
      new Date(),
      new Uint8Array(2),
      new Map(),
      { x: undefined },
      Array(2),
    ])
      expect(() => plan({ ...commit, response: invalid })).toThrow(/JSON/);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => plan({ ...commit, response: cycle })).toThrow(/JSON/);
    expect(() => plan({ ...commit, response: Object.create({ inherited: true }) })).toThrow(/JSON/);
    const sparse = Array(1);
    Object.assign(sparse, { extra: true });
    expect(() => plan({ ...commit, response: sparse })).toThrow(/arrays/);
    let nested: unknown = {};
    for (let i = 0; i < 18; i++) nested = { child: nested };
    expect(() => plan({ ...commit, response: nested })).toThrow(/depth/);
    expect(() =>
      plan({ ...commit, response: Array.from({ length: 10_001 }, () => null) }),
    ).toThrow();
    expect(workflowCommitLimits.actions).toBe(60);
  });
  it("checks the normalized total including all individually valid auxiliary creates", () => {
    const record = defineAtomicRecord({
      name: "bounded",
      schema: z.strictObject({ id: z.string(), text: z.string() }),
      key: (v) => v.id,
      owner: () => ({ resourceType: "document", resourceId: "doc_1" }),
    });
    const records = Array.from({ length: 18 }, (_, i) =>
      record.create({ id: `record_${i}`, text: "x".repeat(60_000) }),
    );
    expect(() =>
      planner({ records: [record], contribute: () => ({ records }) }).plan(invocation(), input()),
    ).toThrow(/byte budget/);
  });
  it("does not invoke accessors while checking JSON", () => {
    let invoked = false;
    const data = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        invoked = true;
        return "secret";
      },
    });
    expect(() => plan({ ...input(), response: data })).toThrow(/accessors/);
    expect(invoked).toBe(false);
  });
});

describe("adapter-neutral key compatibility", () => {
  it("retains legacy key families and exact projection sort identity", () => {
    expect(workflowRecordKeys.resource("document", "doc_1")).toEqual({
      partition: "RES#document#doc_1",
      sort: "STATE",
    });
    expect(workflowRecordKeys.activity(input().activity[0]!)).toEqual({
      partition: "RES#document#doc_1",
      sort: `ACT#${now}#act_1`,
    });
    expect(workflowRecordKeys.outbox("evt_1")).toEqual({
      partition: "OUTBOX#evt_1",
      sort: "EVENT",
    });
    expect(workflowRecordKeys.idempotency(scope, "key_1")).toEqual({
      partition: "IDEMP#document#create#user_1",
      sort: "key_1",
    });
    expect(
      workflowRecordKeys.projection("document", {
        projectionName: "document.status.open",
        itemId: "doc_1",
        sort: `${now}#doc_1`,
      }),
    ).toEqual({ partition: "PROJ#document#status#open", sort: `${now}#doc_1` });
  });
});
