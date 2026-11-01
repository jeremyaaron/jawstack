import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  createWorkflowCommitPlanner,
  defineAtomicRecord,
  type CommandCommitInput,
  type WorkflowCommitPlan,
} from "@jawstack/core";
import { DynamoDbRepository } from "@jawstack/aws-runtime";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { createContentDispatch } from "../../src/application/dispatch";
import { createMemoryPersistence } from "../../src/application/memory";
import { prepareTransaction } from "../../src/application/persistence";
import {
  publicationOperationKey,
  publicationOperationProjections,
  publicationOperations,
} from "../../src/application/publication-operations";
import { publicationOperationSchema } from "../../src/shared/operation-views";
import { createDynamoPersistence } from "../../src/aws/persistence";
import { createMemoryObjectStore } from "../../src/application/object-store";
import { createPublisher } from "../../src/application/publisher";
import { parseContentEvent } from "../../src/shared/events";
import { fixtureAuth } from "../../src/shared/identities";
import type { ContentState } from "../../src/shared/contracts";
import { TransactionClient } from "../support/transaction-client";

const commandReceipt = defineAtomicRecord({
  name: "commandReceipt",
  schema: z.strictObject({
    kind: z.literal("commandReceipt"),
    resourceType: z.string(),
    resourceId: z.string(),
    commandName: z.string(),
    subject: z.string(),
    version: z.number().int().positive(),
    committedAt: z.string(),
  }),
  key: (r) => `${r.resourceType}#${r.resourceId}#${r.version}`,
  owner: (r) => ({ resourceType: r.resourceType, resourceId: r.resourceId }),
});
const attempt = defineAtomicRecord({
  name: "publicationAttempt",
  schema: publicationOperationSchema,
  key: (r) => publicationOperationKey(r).SK,
  owner: (r) => ({ resourceType: "contentItem", resourceId: r.contentId }),
});
function planner() {
  return createWorkflowCommitPlanner({
    workflowName: "content-operations",
    source: "content-operations",
    idempotencyTtlSeconds: 604800,
    records: [commandReceipt, attempt],
    contribute: ({ invocation, commit }) => {
      const operations = publicationOperations(commit, invocation.scope.commandName);
      return {
        records: [
          commandReceipt.create({
            kind: "commandReceipt",
            ...invocation.scope,
            resourceId: commit.resource.resourceId,
            version: commit.resource.next.version,
            committedAt: invocation.now,
          }),
          ...operations.map((r) => attempt.create(r)),
        ],
        projections: publicationOperationProjections(operations),
      };
    },
  });
}
function compareKeys(plan: WorkflowCommitPlan, legacy: ReturnType<typeof prepareTransaction>) {
  const actual = plan.actions.map((a) => JSON.stringify([a.key.partition, a.key.sort])).sort();
  const expected = legacy.items
    .map((a) => {
      const item = unmarshall(a.Put?.Item ?? a.Delete!.Key!);
      return JSON.stringify([item.PK, item.SK]);
    })
    .sort();
  expect(actual).toEqual(expected);
  for (const action of plan.actions.filter((a) => a.kind === "outbox")) {
    const old = legacy.items
      .map((i) => i.Put && unmarshall(i.Put.Item!))
      .find((i) => i && i.eventId === action.value.eventId)!;
    expect(JSON.stringify(action.value)).toBe(JSON.stringify(old.event));
  }
}

describe("pre-migration workflow planner compatibility", () => {
  it("preserves frozen command rows/keys and canonical wire order without recapturing the golden", () => {
    const golden = JSON.parse(
      readFileSync(
        new URL(
          "../../../../docs/iterations/003-framework-leverage/leverage/compatibility.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      commandInput: CommandCommitInput;
      wireJson: string;
      transaction: { Put: { Item: Record<string, unknown> } }[];
    };
    const scope = { resourceType: "contentItem", commandName: "create", subject: "author_1" };
    const result = planner().plan(
      { scope, now: golden.commandInput.resource.next.updatedAt },
      golden.commandInput,
    );
    const legacy = prepareTransaction(
      golden.commandInput,
      scope,
      new Date(golden.commandInput.resource.next.updatedAt),
      "compatibility-table",
    );
    compareKeys(result, legacy);
    expect(legacy.items).toEqual(golden.transaction);
    expect(JSON.stringify(result.actions.find((a) => a.kind === "outbox")!.value)).toBe(
      golden.wireJson,
    );
    const record = result.actions.find((a) => a.kind === "record")!;
    const old = legacy.operations[0]!;
    expect(record.value).toEqual(old);
  });

  it.each(["memory", "dynamo"] as const)(
    "fits actual editorial and publication fixtures in %s without migrating storage",
    async (backend) => {
      const clock = () => new Date("2026-11-01T12:00:00.000Z");
      const memory = createMemoryPersistence(),
        client = new TransactionClient();
      const factory =
        backend === "memory"
          ? memory.factory
          : createDynamoPersistence({ client, tableName: "test" });
      const repository =
        backend === "memory"
          ? memory.repository
          : new DynamoDbRepository({ client, tableName: "test", consistentRead: true });
      const plans: WorkflowCommitPlan[] = [];
      const p = planner();
      const dispatch = createContentDispatch({
        clock,
        persistence: (scope, now) => {
          const existing = factory(scope, now);
          return {
            repository: existing.repository,
            unitOfWork: {
              commit: async (input) => {
                const result = p.plan({ scope, now: now.toISOString() }, input);
                compareKeys(result, prepareTransaction(input, scope, now, "test"));
                plans.push(result);
                await existing.unitOfWork.commit(input);
              },
            },
          };
        },
      });
      const id = randomUUID();
      const current = async () => (await repository.getState<ContentState>("contentItem", id))!;
      let sequence = 0;
      const run = async (commandName: string, input: unknown, editor = true) => {
        const result = await dispatch(
          {
            resourceType: "contentItem",
            resourceId: id,
            commandName,
            input,
            idempotencyKey: `compat:${++sequence}`,
            requestContext: {},
          },
          fixtureAuth(editor ? "editor_1" : "author_1"),
        );
        expect(result).toMatchObject({ ok: true });
      };
      await run("create", { title: "Compatible draft", body: "x".repeat(4000) }, false);
      await run(
        "submit",
        { expectedVersion: 1, assignedEditorId: "editor_1", dueAt: "2026-11-02T12:00:00.000Z" },
        false,
      );
      const review = (await current()).state.review!;
      await run("approve", {
        expectedVersion: 2,
        reviewId: review.reviewId,
        revisionId: review.submitted.revisionId,
        note: "Approved",
      });
      await run("publishNow", {
        expectedVersion: 3,
        reviewId: review.reviewId,
        revisionId: review.submitted.revisionId,
      });
      const request = plans
        .flatMap((p) => p.actions)
        .find(
          (a) => a.kind === "outbox" && a.value.eventType === "contentItem.publicationRequested",
        );
      if (!request || request.kind !== "outbox") throw new Error("Missing publication request.");
      await createPublisher({
        repository,
        dispatch,
        clock,
        objects: createMemoryObjectStore({ clock }),
      })(parseContentEvent(request.value));
      expect((await current()).state.publication?.phase).toBe("succeeded");
      expect(
        plans.some((p) =>
          p.actions.some((a) => a.kind === "record" && a.collection === "publicationAttempt"),
        ),
      ).toBe(true);
      expect(plans).toHaveLength(6);
    },
  );
});
