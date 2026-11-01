import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDbItem } from "@jawstack/aws-runtime";
import { describe, expect, it } from "vitest";
import { createMemoryJobStore } from "../../src/application/job-store";
import { createDynamoJobStore } from "../../src/aws/job-store";
import { createFixtureClock } from "../../src/application/runtime";

class JobClient {
  items = new Map<string, DynamoDbItem>();
  puts: PutItemCommand["input"][] = [];
  mode: "normal" | "failure" | "ambiguous" = "normal";
  async send(command: { input: unknown }) {
    if (command instanceof GetItemCommand) {
      expect(command.input.ConsistentRead).toBe(true);
      return { Item: structuredClone(this.items.get(JSON.stringify(command.input.Key))) };
    }
    if (!(command instanceof PutItemCommand)) throw new Error("Unsupported job command");
    this.puts.push(command.input);
    if (this.mode === "failure") throw new Error("sensitive checkpoint failure");
    const item = command.input.Item!;
    const key = JSON.stringify({ PK: item.PK, SK: item.SK });
    const oldItem = this.items.get(key);
    const old = oldItem && unmarshall(oldItem);
    const values = unmarshall(command.input.ExpressionAttributeValues ?? {});
    let allowed;
    switch (command.input.ConditionExpression) {
      case "attribute_not_exists(PK)":
        allowed = !old;
        break;
      case "#revision = :revision AND (attribute_type(#until, :nullType) OR #until <= :now)":
        allowed =
          !!old &&
          old.revision === values[":revision"] &&
          (old.leaseUntil === null || String(old.leaseUntil) <= String(values[":now"]));
        break;
      case "#token = :token AND #revision = :revision AND #started <= :now AND #until > :now":
        allowed =
          old?.token === values[":token"] &&
          old?.revision === values[":revision"] &&
          String(old?.startedAt) <= String(values[":now"]) &&
          String(old?.leaseUntil) > String(values[":now"]);
        break;
      default:
        throw new Error("Unsupported checkpoint condition");
    }
    if (!allowed)
      throw Object.assign(new Error("condition"), { name: "ConditionalCheckFailedException" });
    this.items.set(key, structuredClone(item));
    if (this.mode === "ambiguous") throw new Error("sensitive response lost");
    return {};
  }
}
describe.each(["memory", "dynamo"] as const)("%s leased checkpoints", (adapter) => {
  const setup = () => {
    const client = new JobClient();
    const store =
      adapter === "memory"
        ? createMemoryJobStore()
        : createDynamoJobStore({ client, tableName: "test" });
    return { store, client, clock: createFixtureClock("2026-10-31T12:00:00.000Z") };
  };
  it("has one acquisition winner and preserves progress through release/reacquisition", async () => {
    const h = setup();
    const grants = await Promise.all(
      Array.from({ length: 5 }, () => h.store.acquire("dueReview", h.clock.now())),
    );
    expect(grants.filter(Boolean)).toHaveLength(1);
    const lease = grants.find(Boolean)!;
    const progress = { passCutoff: h.clock.now().toISOString(), cursor: "opaque-cursor" };
    await h.store.save(lease, progress, h.clock.now(), true);
    const next = await h.store.acquire("dueReview", h.clock.now());
    expect(next!.progress).toEqual(progress);
    expect(next!.token).not.toBe(lease.token);
    await expect(
      h.store.save(lease, { passCutoff: null, cursor: null }, h.clock.now(), true),
    ).rejects.toMatchObject({ code: "resource.conflict" });
  });
  it("resumes after exact lease expiry and fences an old worker even with its original clock", async () => {
    const h = setup();
    const initial = h.clock.now();
    const first = (await h.store.acquire("duePublication", initial))!;
    const progress = { passCutoff: initial.toISOString(), cursor: "saved-cursor" };
    await h.store.save(first, progress, initial);
    h.clock.advance(29_999);
    expect(await h.store.acquire("duePublication", h.clock.now())).toBeUndefined();
    h.clock.advance(1);
    const second = (await h.store.acquire("duePublication", h.clock.now()))!;
    expect(second.progress).toEqual(progress);
    await expect(
      h.store.save(first, { passCutoff: null, cursor: null }, initial),
    ).rejects.toMatchObject({ code: "resource.conflict" });
    await expect(h.store.save(first, progress, h.clock.now())).rejects.toMatchObject({
      code: "resource.conflict",
    });
    await h.store.save(second, progress, h.clock.now(), true);
  });
  it("rejects regressed clocks, invalid job names and malformed progress", async () => {
    const h = setup();
    const lease = (await h.store.acquire("expireUploads", h.clock.now()))!;
    await expect(
      h.store.save(lease, lease.progress, new Date(h.clock.now().getTime() - 1)),
    ).rejects.toMatchObject({ code: "resource.conflict" });
    await expect(h.store.acquire("unknown" as "dueReview", h.clock.now())).rejects.toThrow();
    await expect(
      h.store.save(lease, { passCutoff: null, cursor: "invalid" }, h.clock.now()),
    ).rejects.toThrow();
  });
});
describe("Dynamo checkpoint failure semantics", () => {
  it("sanitizes failure and does not treat an ambiguous acquisition as a usable lease", async () => {
    const client = new JobClient();
    const store = createDynamoJobStore({ client, tableName: "test" });
    const now = new Date("2026-10-31T12:00:00.000Z");
    client.mode = "failure";
    await expect(store.acquire("cleanupOrphans", now)).rejects.toMatchObject({
      message: "Job checkpoint acquisition failed.",
    });
    client.mode = "ambiguous";
    await expect(store.acquire("cleanupOrphans", now)).rejects.toMatchObject({
      code: "runtime.unavailable",
    });
    client.mode = "normal";
    expect(await store.acquire("cleanupOrphans", now)).toBeUndefined();
    expect(await store.acquire("cleanupOrphans", new Date(now.getTime() + 30_000))).toBeDefined();
    expect(client.puts.every((put) => put.ConditionExpression)).toBe(true);
  });
});
