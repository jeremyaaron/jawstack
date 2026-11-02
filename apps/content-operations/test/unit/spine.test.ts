import { describe, expect, it, vi } from "vitest";
import { createInMemoryPersistence, executeCommand, TestAuthProvider } from "@jawstack/core";
import { buildCommandTransactWriteItems } from "@jawstack/aws-runtime";
import { proofResource } from "../../src/lab/resource";
import { missing, waitFor } from "../../src/lab/provision";

describe("transactional spine harness", () => {
  it("uses real public command contracts and atomically commits every proof record", async () => {
    const memory = createInMemoryPersistence();
    const commit = vi.spyOn(memory.unitOfWork, "commit");
    const options = {
      registry: [proofResource],
      repository: memory.repository,
      unitOfWork: memory.unitOfWork,
      authProvider: new TestAuthProvider({
        subject: "lab_user",
        roles: ["lab"],
        claims: {},
        mode: "test",
      }),
    };
    const request = {
      resourceType: "spineProof",
      resourceId: "proof_1",
      commandName: "create",
      input: { message: "proof" },
      idempotencyKey: "key_1",
      requestContext: {},
    };
    const result = await executeCommand(request, options);
    expect(result.ok).toBe(true);
    expect(await executeCommand(request, options)).toEqual(result);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(memory.store.resources.size).toBe(1);
    expect(memory.store.activity).toHaveLength(1);
    expect(memory.store.outbox).toHaveLength(1);
    expect(memory.store.projections.size).toBe(1);
    expect(memory.store.idempotency.size).toBe(1);
    const transaction = buildCommandTransactWriteItems(commit.mock.calls[0]![0], {
      tableName: "proof",
      idempotency: { commandName: "create", subject: "lab_user" },
    });
    expect(transaction).toHaveLength(5);
    expect(transaction.map((x) => x.Put?.Item?.itemKind)).toEqual([
      { S: "RESOURCE_STATE" },
      { S: "ACTIVITY" },
      { S: "OUTBOX_EVENT" },
      { S: "PROJECTION_ITEM" },
      { S: "IDEMPOTENCY_RECORD" },
    ]);
  });

  it("rejects unauthorized/invalid proof inputs without partial records", async () => {
    const memory = createInMemoryPersistence();
    const options = {
      registry: [proofResource],
      repository: memory.repository,
      unitOfWork: memory.unitOfWork,
      authProvider: new TestAuthProvider({ subject: "other", roles: [], claims: {}, mode: "test" }),
    };
    const result = await executeCommand(
      {
        resourceType: "spineProof",
        commandName: "create",
        input: { message: "proof" },
        requestContext: {},
      },
      options,
    );
    expect(result.ok).toBe(false);
    expect(memory.store.resources.size).toBe(0);
    expect(memory.store.outbox).toHaveLength(0);
  });

  it("does not swallow transport failures as missing resources", async () => {
    await expect(
      missing(async () => {
        throw Object.assign(new Error(), { name: "ResourceNotFoundException" });
      }),
    ).resolves.toBeUndefined();
    await expect(
      missing(async () => {
        throw new Error("transport failure");
      }),
    ).rejects.toThrow("transport failure");
  });

  it("bounds polling and succeeds without a fixed readiness sleep", async () => {
    expect(await waitFor("ready", async () => "ready", 1)).toBe("ready");
    await expect(
      waitFor(
        "never",
        async () => undefined,
        0,
        async () => undefined,
      ),
    ).rejects.toThrow("Timed out");
  });
});
