import { randomUUID } from "node:crypto";
import { DynamoDbRepository } from "@jawstack/aws-runtime";
import { createDynamoPersistence } from "../aws/persistence";
import { createDynamoJobStore } from "../aws/job-store";
import { createLocalS3ObjectStore } from "../aws/object-store";
import { createContentJobs } from "../application/jobs";
import { createContentDispatch } from "../application/dispatch";
import { createFixtureClock } from "../application/runtime";
import { fixtureAuth } from "../shared/identities";
import type { ContentState } from "../shared/contracts";
import { LabError, type LabConfig } from "./config";
import type { LabClients } from "./clients";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new LabError(`Jobs proof: ${message}`);
}
export async function verifyJobs(clients: LabClients, config: LabConfig) {
  const runId = randomUUID();
  const clock = createFixtureClock(new Date().toISOString());
  const initial = clock.now();
  const objects = createLocalS3ObjectStore(config);
  const repository = new DynamoDbRepository({ client: clients.dynamo, tableName: config.table });
  const store = createDynamoJobStore({ client: clients.dynamo, tableName: config.table });
  const dispatch = createContentDispatch({
    persistence: createDynamoPersistence({ client: clients.dynamo, tableName: config.table }),
    clock: clock.now,
    source: config.source,
  });
  const jobs = createContentJobs({ repository, store, objects, dispatch, clock: clock.now });
  let sequence = 0;
  const current = async (id: string) =>
    (await repository.getState<ContentState>("contentItem", id))!;
  const run = (id: string, commandName: string, input: unknown, editor = false) =>
    dispatch(
      {
        resourceType: "contentItem",
        resourceId: id,
        commandName,
        input,
        idempotencyKey: `jobs-proof:${runId}:${++sequence}`,
        requestContext: {},
      },
      fixtureAuth(editor ? "editor_1" : "author_1"),
    );
  const dueAt = new Date(initial.getTime() + 3_600_000).toISOString();
  const create = async (review = false) => {
    const id = randomUUID();
    check(
      (await run(id, "create", { title: "Checkpointed due work", body: "Owned local job proof" }))
        .ok,
      "create failed",
    );
    if (review)
      check(
        (await run(id, "submit", { expectedVersion: 1, assignedEditorId: "editor_1", dueAt })).ok,
        "submit failed",
      );
    return id;
  };
  try {
    const reviews = [await create(true), await create(true)];
    const publication = await create(true);
    const submitted = await current(publication);
    check(
      (
        await run(
          publication,
          "approve",
          {
            expectedVersion: submitted.version,
            reviewId: submitted.state.review!.reviewId,
            revisionId: submitted.state.revisionId,
            note: "Approved",
          },
          true,
        )
      ).ok,
      "approval failed",
    );
    const approved = await current(publication);
    check(
      (
        await run(
          publication,
          "schedule",
          {
            expectedVersion: approved.version,
            reviewId: approved.state.approval!.reviewId,
            revisionId: approved.state.revisionId,
            scheduledAt: dueAt,
            timeZone: "UTC",
          },
          true,
        )
      ).ok,
      "schedule failed",
    );
    const upload = await create();
    check(
      (
        await run(upload, "registerAsset", {
          expectedVersion: 1,
          filename: "orphan.pdf",
          mediaType: "application/pdf",
          expectedSize: 15,
        })
      ).ok,
      "registration failed",
    );
    const slot = (await current(upload)).state.attachments[0]!;
    const bytes = Buffer.from("%PDF-1.7\n%%EOF\n");
    check(bytes.length === slot.expectedSize, "fixture size mismatch");
    await objects.create(slot, bytes);
    clock.advance(3_600_000);
    const overlap = await Promise.all([jobs.tick("duePublication"), jobs.tick("duePublication")]);
    check(
      overlap.filter((r) => r.status === "busy").length === 1 &&
        overlap.reduce((sum, r) => sum + r.succeeded, 0) === 1,
      "overlapping publication ticks diverged",
    );
    check((await current(publication)).state.status === "publishing", "publication not requested");
    const first = await jobs.tick("dueReview", { maxItems: 1 });
    check(first.status === "yielded" && first.succeeded === 1, "review checkpoint not saved");
    const resumed = createContentJobs({
      repository,
      objects,
      dispatch,
      store: createDynamoJobStore({ client: clients.dynamo, tableName: config.table }),
      clock: clock.now,
    });
    check((await resumed.tick("dueReview")).succeeded === 1, "review restart failed");
    check((await resumed.tick("dueReview")).succeeded === 0, "duplicate reminder");
    for (const id of reviews)
      check(
        (await current(id)).state.review!.lastReminderDay ===
          clock.now().toISOString().slice(0, 10),
        "missing authoritative reminder",
      );
    check((await jobs.tick("expireUploads")).succeeded === 1, "slot expiry failed");
    check((await jobs.tick("cleanupOrphans")).succeeded === 0, "young orphan deleted");
    clock.advance(24 * 3_600_000);
    check((await jobs.tick("cleanupOrphans")).succeeded === 1, "old orphan not deleted");
    check(
      (await objects.inspectAssetObject({ contentId: upload, assetId: slot.assetId })) ===
        undefined,
      "orphan survived conditional delete",
    );
    check(
      (await current(upload)).state.attachments[0]!.status === "expired",
      "cleanup removed tombstone",
    );
    // Exercise expired ownership independently of released tick checkpoints.
    const lease = (await store.acquire("expireUploads", clock.now()))!;
    check(
      lease && (await store.acquire("expireUploads", clock.now())) === undefined,
      "live lease displaced",
    );
    clock.advance(30_000);
    const successor = (await store.acquire("expireUploads", clock.now()))!;
    check(successor && successor.token !== lease.token, "expired lease not replaced");
    let fenced = false;
    try {
      await store.save(lease, lease.progress, new Date(lease.startedAt), true);
    } catch {
      fenced = true;
    }
    check(fenced, "stale checkpoint writer accepted");
    await store.save(successor, successor.progress, clock.now(), true);
    return {
      runId,
      mode: "shared jobs directly on real DynamoDB/S3; injected clock, not deployed consumer Scheduler targets",
      overlappingPublicationOnce: true,
      checkpointRestart: true,
      dailyReminderDedup: true,
      abandonedSlotExpired: true,
      youngObjectRetained: true,
      oldOrphanConditionallyDeleted: true,
      tombstoneRetained: true,
      expiredLeaseTakeoverFenced: true,
    };
  } finally {
    objects.close();
  }
}
