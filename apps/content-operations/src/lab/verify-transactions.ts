import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { DynamoDbRepository, idempotencyKey, projectionKey } from "@jawstack/aws-runtime";
import type { CommandCommitInput, CommandExecutionResult } from "@jawstack/core";
import { createContentDispatch } from "../application/dispatch";
import { createMemoryPersistence } from "../application/memory";
import {
  idempotencyTtlSeconds,
  operationKey,
  type OperationRecord,
} from "../application/persistence";
import { createDynamoPersistence } from "../aws/persistence";
import { fixtureAuth, type FixtureId } from "../shared/identities";
import type { LabClients } from "./clients";
import { LabError, type LabConfig } from "./config";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new LabError(`Scoped transaction proof: ${message}`);
}

export async function verifyScopedTransactions(c: LabClients, config: LabConfig) {
  const runId = randomUUID();
  const ids = Array.from({ length: 7 }, () => randomUUID());
  const started = new Date();
  const read = async (key: { PK: string; SK: string }) =>
    (
      await c.dynamo.send(
        new GetItemCommand({
          TableName: config.table,
          Key: marshall(key),
          ConsistentRead: true,
        }),
      )
    ).Item;
  const results = [];
  for (const adapter of ["memory", "dynamo"] as const) {
    const memory = createMemoryPersistence();
    const factory =
      adapter === "memory"
        ? memory.factory
        : createDynamoPersistence({ client: c.dynamo, tableName: config.table });
    const repository =
      adapter === "memory"
        ? memory.repository
        : new DynamoDbRepository({ client: c.dynamo, tableName: config.table });
    let now = new Date(started);
    const dispatch = createContentDispatch({ persistence: factory, clock: () => now });
    const run = (
      commandName: string,
      input: unknown,
      key: string,
      subject: FixtureId = "author_1",
      resourceId = ids[0]!,
    ) =>
      dispatch(
        {
          resourceType: "contentItem",
          resourceId,
          commandName,
          input,
          requestContext: {},
          idempotencyKey: `${runId}:${key}`,
        },
        fixtureAuth(subject),
      );
    const expectError = (result: CommandExecutionResult, code: string) =>
      check(!result.ok && result.error.code === code, `expected ${code}`);
    const input = { title: "Transaction proof", body: "Local-only bounded content." };
    const concurrent = await Promise.all(
      Array.from({ length: 6 }, () => run("create", input, "shared")),
    );
    check(
      concurrent[0]!.ok && concurrent.every((r) => isDeepStrictEqual(r, concurrent[0])),
      "concurrent replay changed the original response",
    );
    check(
      (await repository.getActivity("contentItem", ids[0]!)).length === 1,
      "duplicate activity",
    );
    check(
      isDeepStrictEqual(await run("create", input, "shared"), concurrent[0]),
      "sequential replay changed response",
    );
    expectError(
      await run("create", { ...input, title: "Conflicting payload" }, "shared"),
      "idempotency.conflict",
    );
    check(
      (await run("create", input, "shared", "author_2", ids[1]!)).ok,
      "subject scopes collided",
    );
    const edits = await Promise.all(
      Array.from({ length: 6 }, () =>
        run("editDraft", { ...input, title: "Edited", expectedVersion: 1 }, "shared"),
      ),
    );
    check(
      edits[0]!.ok && edits.every((r) => isDeepStrictEqual(r, edits[0])),
      "concurrent edit replay changed response",
    );
    expectError(
      await run("editDraft", { ...input, expectedVersion: 1 }, "stale"),
      "resource.conflict",
    );
    check(
      (
        await run(
          "submit",
          {
            expectedVersion: 2,
            assignedEditorId: "editor_1",
            dueAt: new Date(now.getTime() + 86_400_000).toISOString(),
          },
          "submit",
        )
      ).ok,
      "submit failed",
    );
    const due = await repository.listProjection("contentItem.dueReview");
    check(
      due.some((row) => row.itemId === ids[0]),
      "missing due row",
    );
    check(
      !(await repository.listProjection("contentItem.status.draft")).some(
        (row) => row.itemId === ids[0],
      ),
      "stale draft row",
    );
    check((await run("reopenDraft", { expectedVersion: 3 }, "reopen")).ok, "reopen failed");
    check(
      !(await repository.listProjection("contentItem.dueReview")).some(
        (row) => row.itemId === ids[0],
      ),
      "stale due row",
    );
    if (adapter === "dynamo")
      check(
        !(await read(
          projectionKey({
            ...due.find((row) => row.itemId === ids[0])!,
            resourceType: "contentItem",
          }),
        )),
        "old due physical key survived",
      );

    const operation: OperationRecord = {
      kind: "commandReceipt",
      resourceType: "contentItem",
      resourceId: ids[2]!,
      commandName: "create",
      subject: "author_1",
      version: 1,
      committedAt: now.toISOString(),
    };
    if (adapter === "memory")
      memory.operations.set(JSON.stringify(operationKey(operation)), operation);
    else
      await c.dynamo.send(
        new PutItemCommand({
          TableName: config.table,
          Item: marshall({ ...operationKey(operation), itemKind: "APP_OPERATION", ...operation }),
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
    expectError(await run("create", input, "rollback", "author_1", ids[2]!), "resource.conflict");
    check(
      !(await repository.getState("contentItem", ids[2]!)),
      "auxiliary failure persisted primary",
    );
    check(
      (await repository.getActivity("contentItem", ids[2]!)).length === 0,
      "auxiliary failure persisted activity",
    );
    check(
      !(await repository.listProjection("contentItem.list")).some((row) => row.itemId === ids[2]),
      "auxiliary failure persisted projection",
    );
    check(
      !(await factory(
        { resourceType: "contentItem", commandName: "create", subject: "author_1" },
        now,
      ).repository.getIdempotency!(`${runId}:rollback`)),
      "auxiliary failure persisted idempotency",
    );

    // A synthetic single-resource commit isolates exact sort/partition movement from domain decisions.
    const scope = {
      resourceType: "contentItem",
      commandName: "projectionProof",
      subject: "author_1",
    };
    const row = {
      projectionName: `contentItem.transaction.${runId}`,
      itemId: ids[3]!,
      sort: now.toISOString(),
      data: {},
    };
    const commit = async (
      version: number,
      projections: CommandCommitInput["projections"],
      expectedVersion = version - 1,
    ) =>
      factory(scope, now).unitOfWork.commit({
        resource: {
          resourceType: "contentItem",
          resourceId: ids[3]!,
          create: version === 1,
          ...(version === 1 ? {} : { expectedVersion }),
          next: {
            resourceType: "contentItem",
            resourceId: ids[3]!,
            version,
            state: {},
            createdAt: started.toISOString(),
            updatedAt: now.toISOString(),
            createdBy: "author_1",
            updatedBy: "author_1",
          },
        },
        activity: [],
        outbox: [],
        projections,
        response: {},
        idempotency: {
          key: `${runId}:move:${version}`,
          fingerprint: `version:${version}`,
          response: { ok: true, data: {}, meta: { requestId: runId, correlationId: runId } },
        },
      });
    await commit(1, [row]);
    const moved = { ...row, sort: new Date(now.getTime() + 1000).toISOString() };
    await commit(2, [
      { ...row, delete: true },
      moved,
      { ...moved, sort: `${moved.sort}#${moved.itemId}` },
    ]);
    check(
      (await repository.listProjection(row.projectionName)).length === 1,
      "sort move retained duplicate",
    );
    if (adapter === "dynamo")
      check(
        !(await read(projectionKey({ ...row, resourceType: "contentItem" }))),
        "old sort physical key survived",
      );
    const relocated = { ...moved, projectionName: `${row.projectionName}.relocated` };
    await commit(3, [{ ...moved, delete: true }, relocated]);
    check(
      (await repository.listProjection(row.projectionName)).length === 0 &&
        (await repository.listProjection(relocated.projectionName)).length === 1,
      "partition move retained stale row",
    );
    let failed = false;
    try {
      await commit(4, [{ ...relocated, delete: true }], 1);
    } catch {
      failed = true;
    }
    check(
      failed &&
        (await repository.getState("contentItem", ids[3]!))?.version === 3 &&
        (await repository.listProjection(relocated.projectionName)).length === 1,
      "primary condition did not roll back",
    );
    if (adapter === "dynamo")
      check(
        !(await read(operationKey({ ...operation, resourceId: ids[3]!, version: 4 }))),
        "failed version persisted operation",
      );

    const first = await run("create", input, "expiry", "author_1", ids[4]!);
    check(first.ok, "expiry fixture failed");
    const expiryKey = idempotencyKey({
      resourceType: "contentItem",
      commandName: "create",
      subject: "author_1",
      idempotencyKey: `${runId}:expiry`,
    });
    if (adapter === "dynamo")
      check(await read(expiryKey), "TTL record missing before logical expiry");
    now = new Date(now.getTime() + idempotencyTtlSeconds * 1000);
    const replacement = await run("create", input, "expiry", "author_1", ids[5]!);
    check(
      replacement.ok && !isDeepStrictEqual(first, replacement),
      "logical expiry did not replace undeleted record",
    );
    check(
      isDeepStrictEqual(await run("create", input, "expiry", "author_1", ids[5]!), replacement),
      "replacement replay failed",
    );
    results.push({
      adapter,
      concurrentCreates: concurrent.length,
      concurrentEdits: edits.length,
      originalResponseReplay: true,
      commandAndSubjectIsolation: true,
      conflictingReuseRejected: true,
      sevenDayLogicalExpiry: true,
      auxiliaryRollback: true,
      primaryConditionRollback: true,
      statusAndDueMoves: true,
      sortAndPartitionMoves: true,
      physicalActionDeduplication: true,
    });
  }
  return { runId, results, memoryParity: "passed" };
}
