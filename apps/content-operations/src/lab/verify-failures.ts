import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { GetItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { marshall } from "@aws-sdk/util-dynamodb";
import { DynamoDbRepository, workerIdempotencyKey, outboxEventKey } from "@jawstack/aws-runtime";
import { createDynamoPersistence } from "../aws/persistence";
import { createDynamoFailureStore } from "../aws/failures";
import { createDynamoNotificationSink } from "../aws/notifications";
import { createLocalS3ObjectStore } from "../aws/object-store";
import { createContentWorkerSqsHandler, createFailureSqsHandler } from "../aws/recovery";
import { deliveryQueueName } from "../aws/delivery";
import { createContentDispatch } from "../application/dispatch";
import { createFailureService } from "../application/failures";
import { createContentWorkers } from "../application/workers";
import { failedDeliveryId, replayEnvelope } from "../application/failure-records";
import { createPublisher, SimulatedPublicationCrash } from "../application/publisher";
import { createFixtureClock } from "../application/runtime";
import { fixtureAuth } from "../shared/identities";
import { parseContentEvent } from "../shared/events";
import type { ContentState } from "../shared/contracts";
import { LabError, type LabConfig } from "./config";
import { queueArn } from "./capabilities";
import type { LabClients } from "./clients";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new LabError(`Recovery proof: ${message}`);
}
export async function verifyFailures(clients: LabClients, config: LabConfig) {
  const runId = randomUUID();
  const clock = createFixtureClock(new Date().toISOString());
  const repository = new DynamoDbRepository({ client: clients.dynamo, tableName: config.table });
  const store = createDynamoFailureStore({
    client: clients.dynamo,
    tableName: config.table,
    source: config.source,
  });
  const captured: unknown[] = [];
  const factory = createDynamoPersistence({
    client: clients.dynamo,
    tableName: config.table,
    source: config.source,
  });
  const dispatch = createContentDispatch({
    clock: clock.now,
    source: config.source,
    persistence: (scope, now) => {
      const base = factory(scope, now);
      return {
        ...base,
        unitOfWork: {
          commit: async (input) => {
            await base.unitOfWork.commit(input);
            captured.push(...input.outbox);
          },
        },
      };
    },
  });
  const failures = createFailureService({
    store,
    repository,
    dispatch,
    source: config.source,
    clock: clock.now,
  });
  const notifications = createDynamoNotificationSink({
    client: clients.dynamo,
    tableName: config.table,
  });
  const workers = createContentWorkers({
    repository,
    dispatch,
    notifications,
    recovery: failures,
    source: config.source,
    clock: clock.now,
  });
  const objects = createLocalS3ObjectStore(config);
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
        idempotencyKey: `recovery-proof:${runId}:${++sequence}`,
        requestContext: {},
      },
      fixtureAuth(editor ? "editor_1" : "author_1"),
    );
  const create = async () => {
    const id = randomUUID();
    check(
      (await run(id, "create", { title: "Durable delivery recovery", body: "Private proof body" }))
        .ok,
      "create failed",
    );
    check(
      (
        await run(id, "submit", {
          expectedVersion: 1,
          assignedEditorId: "editor_1",
          dueAt: new Date(clock.now().getTime() + 86_400_000).toISOString(),
        })
      ).ok,
      "submit failed",
    );
    return id;
  };
  const get = async (key: { PK: string; SK: string }) =>
    (
      await clients.dynamo.send(
        new GetItemCommand({ TableName: config.table, Key: marshall(key), ConsistentRead: true }),
      )
    ).Item;
  try {
    const id = await create();
    const reviewFact = captured
      .filter(
        (e) => parseContentEvent(e, config.source).eventType === "contentItem.reviewRequested",
      )
      .at(-1)!;
    const fact = parseContentEvent(reviewFact, config.source);
    const failureId = failedDeliveryId("deliverNotification", fact.eventId);
    await failures.collect("deliverNotification", reviewFact);
    const cli = fileURLToPath(new URL("../../scripts/jobs.ts", import.meta.url));
    const cwd = fileURLToPath(new URL("../../", import.meta.url));
    const requestId = randomUUID();
    // Capture child output privately; never expose raw SDK/CLI diagnostics in the lab report.
    let inspected: { id?: string };
    let replayed: { generation?: number };
    try {
      const exec = promisify(execFile);
      inspected = JSON.parse(
        (
          await exec(
            process.execPath,
            [
              "--import",
              "tsx",
              cli,
              "inspect",
              failureId,
              "--actor",
              "editor_1",
              "--lab",
              config.instanceId,
            ],
            { cwd, timeout: 30_000, maxBuffer: 65536 },
          )
        ).stdout,
      );
      replayed = JSON.parse(
        (
          await exec(
            process.execPath,
            [
              "--import",
              "tsx",
              cli,
              "replay",
              failureId,
              "--actor",
              "editor_1",
              "--lab",
              config.instanceId,
              "--request-id",
              requestId,
            ],
            { cwd, timeout: 30_000, maxBuffer: 65536 },
          )
        ).stdout,
      );
    } catch {
      throw new LabError("Recovery proof: owned CLI inspect/replay failed; raw output withheld.");
    }
    check(inspected.id === failureId && replayed.generation === 1, "CLI result mismatch");
    const record = (await store.get(failureId))!;
    const replay = replayEnvelope(record, record.recoveries[0]!);
    check(await get(outboxEventKey(replay.eventId)), "atomic replay outbox missing");
    await failures.replay(failureId, fixtureAuth("editor_1"), requestId);
    check((await store.get(failureId))!.recoveries.length === 1, "repeated request burned a cycle");
    const worker = createContentWorkerSqsHandler({
      client: clients.dynamo,
      tableName: config.table,
      source: config.source,
      consumer: "deliverNotification",
      expectedQueueArn: queueArn(config, deliveryQueueName(config, "deliverNotification")),
      workers,
      recovery: failures,
      clock: clock.now,
    });
    const batch = {
      Records: [
        {
          messageId: randomUUID(),
          eventSource: "aws:sqs",
          awsRegion: config.region,
          eventSourceARN: queueArn(config, deliveryQueueName(config, "deliverNotification")),
          body: JSON.stringify(replay),
        },
      ],
    };
    check((await worker(batch)).processed === 1, "replay execution failed");
    const deliveries = await notifications.query();
    const deliveryCount = deliveries.items.filter(
      (row) => row.data.sourceEventId === fact.eventId,
    ).length;
    check(
      deliveryCount === 1 && (await store.get(failureId))!.resolvedGeneration === 1,
      "business delivery not resolved once",
    );
    await clients.dynamo.send(
      new DeleteItemCommand({
        TableName: config.table,
        Key: marshall(workerIdempotencyKey("deliverNotification", replay.eventId)),
      }),
    );
    check((await worker(batch)).processed === 1, "physical marker deletion did not reprocess");
    check(
      (await notifications.query()).items.filter((row) => row.data.sourceEventId === fact.eventId)
        .length === 1,
      "marker deletion duplicated business delivery",
    );

    const submitted = await current(id);
    check(
      (
        await run(
          id,
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
    const approved = await current(id);
    check(
      (
        await run(
          id,
          "publishNow",
          {
            expectedVersion: approved.version,
            reviewId: approved.state.approval!.reviewId,
            revisionId: approved.state.revisionId,
          },
          true,
        )
      ).ok,
      "publication request failed",
    );
    const publicationFact = captured
      .filter(
        (e) => parseContentEvent(e, config.source).eventType === "contentItem.publicationRequested",
      )
      .at(-1)!;
    const publicationEvent = parseContentEvent(publicationFact, config.source);
    try {
      await createPublisher({
        repository,
        dispatch,
        objects,
        clock: clock.now,
        fault: (point) => {
          if (point === "afterObjectWrite") throw new SimulatedPublicationCrash();
        },
      })(publicationEvent);
      throw new LabError("Recovery proof: missing injected crash.");
    } catch (error) {
      if (!(error instanceof SimulatedPublicationCrash)) throw error;
    }
    const collector = createFailureSqsHandler({
      client: clients.dynamo,
      tableName: config.table,
      source: config.source,
      consumer: "publishContent",
      expectedQueueArn: queueArn(config, deliveryQueueName(config, "publishContent", true)),
      failures,
      clock: clock.now,
    });
    const dlq = {
      Records: [
        {
          messageId: randomUUID(),
          eventSource: "aws:sqs",
          awsRegion: config.region,
          eventSourceARN: queueArn(config, deliveryQueueName(config, "publishContent", true)),
          body: JSON.stringify(publicationFact),
        },
      ],
    };
    let deferred = false;
    try {
      await collector(dlq);
    } catch (error) {
      deferred = error instanceof Error && "code" in error && error.code === "resource.conflict";
    }
    const publicationFailureId = failedDeliveryId("publishContent", publicationEvent.eventId);
    check(
      deferred && (await store.get(publicationFailureId))!.collections[0]!.resolution === "pending",
      "live claim not deferred after durable record",
    );
    const marker = workerIdempotencyKey("collectFailure.publishContent", publicationEvent.eventId);
    check(!(await get(marker)), "collector marked before reconciliation");
    clock.advance(90_000);
    check((await collector(dlq)).processed === 1, "expired publication reconciliation failed");
    const stalled = await current(id);
    check(stalled.state.publication!.phase === "stalled", "missing stalled publication");
    check(await get(marker), "collector marker missing after reconciliation");
    check(
      (
        await run(
          id,
          "retryPublication",
          {
            expectedVersion: stalled.version,
            publicationId: stalled.state.publication!.intent.publicationId,
            generation: 1,
          },
          true,
        )
      ).ok,
      "editor retry failed",
    );
    const retry = captured
      .filter(
        (e) => parseContentEvent(e, config.source).eventType === "contentItem.publicationRetried",
      )
      .at(-1)!;
    check(
      (await createPublisher({ repository, dispatch, objects, clock: clock.now })(
        parseContentEvent(retry, config.source),
      )) === "published",
      "publication recovery failed",
    );
    const completed = await current(id);
    await clients.dynamo.send(
      new DeleteItemCommand({ TableName: config.table, Key: marshall(marker) }),
    );
    await collector(dlq);
    check(
      (await current(id)).version === completed.version,
      "late failure replaced successful publication",
    );
    const listed = await clients.s3.send(
      new ListObjectsV2Command({ Bucket: config.bucket, Prefix: `publications/${id}/` }),
    );
    check(listed.Contents?.length === 1, "publication recovery duplicated artifact");
    return {
      runId,
      failureId,
      mode: "shared SQS adapters directly on real DynamoDB/S3; CLI on owned lab, not deployed consumer queues",
      cliInspectReplay: true,
      atomicReplayOutbox: true,
      oneManualCycle: true,
      physicalMarkerDeletionOneDelivery: true,
      durableRecordBeforeLiveClaimDeferral: true,
      collectorMarkedOnlyAfterReconciliation: true,
      editorRetryOneArtifact: true,
      lateFailurePreservedSuccess: true,
    };
  } finally {
    objects.close();
  }
}
