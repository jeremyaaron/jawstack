import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  DeleteItemCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { outboxEventKey, workerIdempotencyKey, type DynamoDbItem } from "@jawstack/aws-runtime";
import type { JawStackEvent } from "@jawstack/core";
import type { ContentWorkerName } from "../domain/subscriptions";
import { createLocalstackApiRuntime } from "../aws/api-runtime";
import { createS3ObjectStore } from "../aws/object-store";
import { createDynamoFailureStore } from "../aws/failures";
import { failedDeliveryId } from "../application/failure-records";
import { deliveryQueueName } from "../aws/delivery";
import { contentStateSchema, reviewTaskStateSchema } from "../shared/contracts";
import { parseContentWire } from "../shared/events";
import { serializePublication } from "../application/publication-artifact";
import { startContentApi } from "../http/server";
import { LabError, localQueueUrl, type LabConfig } from "./config";
import type { LabClients } from "./clients";
import { waitFor } from "./lifecycle";
import {
  controlKey,
  controlSchema,
  receiptPartition,
  type VerificationControl,
} from "./verification-state";
import { instrumentWorkers } from "./verification-code";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new LabError(`Delivery proof: ${message}`);
}
export async function verifyDelivery(clients: LabClients, config: LabConfig, ownerId: string) {
  const runId = randomUUID();
  const deadline = Date.now() + 15 * 60_000;
  const poll = <T>(description: string, read: () => Promise<T | undefined>) =>
    waitFor(description, read, Math.max(0, deadline - Date.now()));
  const restore = await instrumentWorkers(clients, config, ownerId);
  const runtime = await createLocalstackApiRuntime({ labId: config.instanceId }).catch(
    async (error: unknown) => {
      await restore();
      throw error;
    },
  );
  const api = await startContentApi({ runtime, port: 0 }).catch(async (error: unknown) => {
    try {
      await runtime.close?.();
    } finally {
      await restore();
    }
    throw error;
  });
  const failures = createDynamoFailureStore({
    client: clients.dynamo,
    tableName: config.table,
    source: config.source,
  });
  const json = async (path: string, input?: unknown, actor = "editor_1") => {
    const response = await fetch(`${api.baseUrl}${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers: { "x-content-ops-fixture": actor, "content-type": "application/json" },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json()) as {
      ok: boolean;
      data: Record<string, unknown>;
      error?: { code: string };
      meta: unknown;
    };
    check(
      !/objectKey|fencingToken|secretAccessKey|accessKeyId/.test(JSON.stringify(body)),
      "private metadata escaped",
    );
    return { status: response.status, body };
  };
  const command = async (
    name: string,
    id: string | undefined,
    input: unknown,
    key = randomUUID(),
  ) => {
    const result = await json(`/api/resources/contentItem/${id ? `${id}/` : ""}commands/${name}`, {
      input,
      idempotencyKey: key,
    });
    check(result.body.ok, `command ${name} failed (${result.body.error?.code ?? result.status})`);
    return result.body;
  };
  const current = async (id: string) => {
    const row = await runtime.repository.getState("contentItem", id);
    check(row, "missing content authority");
    return { ...row, state: contentStateSchema.parse(row.state) };
  };
  const get = async (key: { PK: string; SK: string }) => {
    const output = await clients.dynamo.send(
      new GetItemCommand({ TableName: config.table, Key: marshall(key), ConsistentRead: true }),
    );
    return output.Item ? unmarshall(output.Item) : undefined;
  };
  const controls = async (
    id: string,
    consumer: ContentWorkerName,
    mode: VerificationControl["mode"],
    collector = false,
  ) => {
    const control = controlSchema.parse({
      ownerId,
      runId,
      contentId: id,
      consumer,
      collector,
      mode,
      remaining: mode === "observe" ? 0 : 1,
    });
    await clients.dynamo.send(
      new PutItemCommand({
        TableName: config.table,
        Item: marshall({ ...controlKey(ownerId, id, consumer, collector), ...control }),
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  };
  const receipts = async (
    id: string,
    consumer: ContentWorkerName,
    point = "received",
    collector = false,
  ) => {
    const output = await clients.dynamo.send(
      new QueryCommand({
        TableName: config.table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: marshall({
          ":pk": receiptPartition(ownerId, runId),
          ":prefix": `${collector ? "collector" : "worker"}#${consumer}#${id}#`,
        }),
        ConsistentRead: true,
        Limit: 100,
      }),
    );
    check(!output.LastEvaluatedKey, "receipt budget exceeded");
    return (output.Items ?? []).map((row) => unmarshall(row)).filter((row) => row.point === point);
  };
  const fact = async (id: string, type: string) => {
    let key: DynamoDbItem | undefined;
    for (let page = 0; page < 20; page++) {
      const output = await clients.dynamo.send(
        new QueryCommand({
          TableName: config.table,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: marshall({ ":pk": "OUTBOX#PUBLISHED" }),
          Limit: 100,
          ...(key ? { ExclusiveStartKey: key } : {}),
        }),
      );
      const found = (output.Items ?? [])
        .map((item) => unmarshall(item))
        .find(
          (item) =>
            (item.event as { resourceId?: string; eventType?: string } | undefined)?.resourceId ===
              id && (item.event as { eventType?: string }).eventType === type,
        );
      if (found) {
        const strong = await get(outboxEventKey(String(found.eventId)));
        return strong?.status === "PUBLISHED"
          ? parseContentWire(strong.event, config.source)
          : undefined;
      }
      if (!output.LastEvaluatedKey) return undefined;
      key = output.LastEvaluatedKey;
    }
    throw new LabError("Published outbox query exceeded its page budget.");
  };
  const committedFact = (id: string, type: string) =>
    poll(`committed ${type} event`, () => fact(id, type));
  const republish = async (event: JawStackEvent) => {
    const result = await clients.events.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: config.bus,
            Source: config.source,
            DetailType: event.eventType,
            Detail: JSON.stringify(event),
          },
        ],
      }),
    );
    check(!result.FailedEntryCount, "diagnostic event republish failed");
  };
  const clearMarker = (consumer: string, eventId: string) =>
    clients.dynamo.send(
      new DeleteItemCommand({
        TableName: config.table,
        Key: marshall(workerIdempotencyKey(consumer, eventId)),
      }),
    );
  const marker = (consumer: string, eventId: string) =>
    get(workerIdempotencyKey(consumer, eventId));
  const pageAll = async (view: string, id: string) => {
    const items: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await json(
        `/api/operations?view=${view}&contentId=${id}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      check(result.body.ok, "paged operations query failed");
      for (const row of result.body.data.items as { data: Record<string, unknown> }[])
        items.push(row.data);
      cursor = result.body.data.nextCursor as string | undefined;
      if (cursor) {
        check(!seen.has(cursor) && seen.size < 30, "operations cursor repeated/exceeded budget");
        seen.add(cursor);
      }
    } while (cursor);
    return items;
  };
  const drained = async (consumer: ContentWorkerName) => {
    const name = deliveryQueueName(config, consumer, true);
    const queue = await clients.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
    const url = localQueueUrl(queue.QueueUrl!, config, name);
    await poll(`actual ${consumer} DLQ acknowledgement`, async () => {
      const response = await clients.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: url,
          AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
        }),
      );
      return response.Attributes?.ApproximateNumberOfMessages === "0" &&
        response.Attributes.ApproximateNumberOfMessagesNotVisible === "0"
        ? true
        : undefined;
    });
  };
  const create = async () =>
    (
      await command("create", undefined, {
        title: "Deployed failure evidence",
        body: "Real queue/Lambda diagnostic fixture.",
      })
    ).data.resourceId as string;
  const submit = async (id: string) => {
    const row = await current(id);
    await command("submit", id, {
      expectedVersion: row.version,
      assignedEditorId: "editor_1",
      dueAt: new Date(Date.now() + 86400000).toISOString(),
    });
  };
  const approve = async (id: string) => {
    const row = await current(id);
    await command("approve", id, {
      expectedVersion: row.version,
      reviewId: row.state.review!.reviewId,
      revisionId: row.state.revisionId,
      note: "Approved live failure evidence.",
    });
  };
  const publication = async (mode: "transient" | "crash" | "terminal") => {
    const id = await create();
    await controls(id, "publishContent", mode);
    await controls(id, "materializeReview", "observe");
    await controls(id, "deliverNotification", "observe");
    if (mode === "terminal") await controls(id, "publishContent", "collectorAfterRecord", true);
    await submit(id);
    await approve(id);
    const row = await current(id);
    await command("publishNow", id, {
      expectedVersion: row.version,
      reviewId: row.state.approval!.reviewId,
      revisionId: row.state.revisionId,
    });
    return id;
  };
  const succeeded = (id: string) =>
    poll("actual publisher completion", async () => {
      const row = await current(id);
      return row.state.status === "published" ? row : undefined;
    });
  const oneArtifact = async (id: string) => {
    const row = await current(id);
    check(row.state.publication, "no frozen intent");
    const expected = serializePublication(row.state.publication.intent);
    check(
      Buffer.from(await runtime.objects.readPublication(row.state.publication.intent)).equals(
        expected.bytes,
      ),
      "artifact bytes differ",
    );
    const objects = await clients.s3.send(
      new ListObjectsV2Command({ Bucket: config.bucket, Prefix: `publications/${id}/` }),
    );
    check(!objects.IsTruncated && objects.Contents?.length === 1, "artifact count differs");
    return expected.reference.sha256;
  };
  try {
    console.log(
      "Queueing transient, object-crash, terminal publisher and terminal notification scenarios...",
    );
    const transientId = await publication("transient");
    const crashId = await publication("crash");
    const terminalId = await publication("terminal");
    const notificationId = await create();
    await controls(notificationId, "deliverNotification", "terminal");
    await submit(notificationId);
    const transientFact = await committedFact(transientId, "contentItem.publicationRequested");
    const crashFact = await committedFact(crashId, "contentItem.publicationRequested");
    const terminalFact = await committedFact(terminalId, "contentItem.publicationRequested");
    const notificationFact = await committedFact(notificationId, "contentItem.reviewRequested");
    await poll("real transient Lambda failure", async () =>
      (await receipts(transientId, "publishContent", "before")).length ? true : undefined,
    );
    check(
      (await current(transientId)).state.publication!.phase === "queued" &&
        !(await marker("publishContent", transientFact.eventId)),
      "transient failure falsely completed",
    );
    await poll("real crash after S3 object write", async () =>
      (await receipts(crashId, "publishContent", "afterObjectWrite")).length ? true : undefined,
    );
    const interrupted = await current(crashId);
    check(interrupted.state.publication!.phase === "running", "crash lost live claim");
    const crashDigest = await oneArtifact(crashId);
    check(
      (await json(`/api/content/${crashId}/publication`)).status === 404,
      "private uncommitted object exposed",
    );
    await republish(crashFact);
    await poll("live-lease duplicate reached actual publisher", async () =>
      (await receipts(crashId, "publishContent")).length >= 2 ? true : undefined,
    );
    check(
      (await current(crashId)).version === interrupted.version &&
        !(await marker("publishContent", crashFact.eventId)),
      "live claim duplicate changed authority",
    );
    console.log(
      "Waiting for automatic SQS retries and publication lease expiry (no clock advance)...",
    );
    await succeeded(transientId);
    await succeeded(crashId);
    const attempts = await pageAll("attempts", crashId);
    check(
      attempts.length === 2 &&
        attempts.some((row) => (row.attempt as { status: string }).status === "expired") &&
        attempts.some((row) => (row.attempt as { status: string }).status === "succeeded"),
      "lease recovery history mismatch",
    );
    check((await oneArtifact(crashId)) === crashDigest, "object-write recovery changed artifact");
    const terminalFailureId = failedDeliveryId("publishContent", terminalFact.eventId);
    console.log(
      "Waiting for real three-receive redrive and deliberately interrupted durable collector...",
    );
    await poll("collector failed after durable record", async () =>
      (await receipts(terminalId, "publishContent", "afterRecord", true)).length ? true : undefined,
    );
    const pending = await failures.get(terminalFailureId);
    check(
      pending?.collections[0]?.resolution === "pending" &&
        !(await marker("collectFailure.publishContent", terminalFact.eventId)),
      "collector acknowledged before reconciliation",
    );
    const dlqName = deliveryQueueName(config, "publishContent", true);
    const dlq = await clients.sqs.send(new GetQueueUrlCommand({ QueueName: dlqName }));
    const dlqUrl = localQueueUrl(dlq.QueueUrl!, config, dlqName);
    const depth = await clients.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
      }),
    );
    check(
      Number(depth.Attributes?.ApproximateNumberOfMessages ?? 0) +
        Number(depth.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0) >=
        1,
      "failed collector source disappeared",
    );
    await poll("collector automatic redelivery/reconciliation", async () =>
      (await failures.get(terminalFailureId))?.collections[0]?.resolution === "stalled"
        ? true
        : undefined,
    );
    await poll("collector completion marker", async () =>
      marker("collectFailure.publishContent", terminalFact.eventId),
    );
    await drained("publishContent");
    const receives = (await receipts(terminalId, "publishContent", "before"))
      .map((row) => Number(row.receiveCount))
      .sort();
    check(
      JSON.stringify(receives) === "[1,2,3]",
      "terminal source did not execute exactly three Lambda receives",
    );
    await clients.dynamo.send(
      new UpdateItemCommand({
        TableName: config.table,
        Key: marshall(controlKey(ownerId, terminalId, "publishContent")),
        UpdateExpression: "SET #mode = :observe",
        ConditionExpression: "ownerId = :owner AND runId = :run",
        ExpressionAttributeNames: { "#mode": "mode" },
        ExpressionAttributeValues: marshall({
          ":observe": "observe",
          ":owner": ownerId,
          ":run": runId,
        }),
      }),
    );
    const stalled = await current(terminalId);
    const retryInput = {
      expectedVersion: stalled.version,
      publicationId: stalled.state.publication!.intent.publicationId,
      generation: 1,
    };
    const retryKey = randomUUID();
    const first = await command("retryPublication", terminalId, retryInput, retryKey);
    check(
      isDeepStrictEqual(await command("retryPublication", terminalId, retryInput, retryKey), first),
      "HTTP retry lost original response",
    );
    const recovered = await succeeded(terminalId);
    check(recovered.state.publication!.generation === 2, "retry burned a generation");
    await clearMarker("publishContent", terminalFact.eventId);
    await republish(terminalFact);
    await poll("obsolete generation marker", async () =>
      marker("publishContent", terminalFact.eventId),
    );
    await clearMarker("collectFailure.publishContent", terminalFact.eventId);
    await clients.sqs.send(
      new SendMessageCommand({ QueueUrl: dlqUrl, MessageBody: JSON.stringify(terminalFact) }),
    );
    await poll("late collector marker", async () =>
      marker("collectFailure.publishContent", terminalFact.eventId),
    );
    await drained("publishContent");
    check(
      (await current(terminalId)).version === recovered.version &&
        (await current(terminalId)).state.status === "published",
      "obsolete work replaced success",
    );
    const notificationFailureId = failedDeliveryId("deliverNotification", notificationFact.eventId);
    await poll("terminal notification durably collected", async () =>
      (await failures.get(notificationFailureId))?.collections[0]?.resolution === "notApplicable"
        ? true
        : undefined,
    );
    await drained("deliverNotification");
    check(
      !(await marker("deliverNotification", notificationFact.eventId)),
      "failed notification marked successful",
    );
    const requestId = randomUUID();
    const cli = async () => {
      try {
        return JSON.parse(
          (
            await promisify(execFile)(
              process.execPath,
              [
                "--import",
                "tsx",
                fileURLToPath(new URL("../../scripts/jobs.ts", import.meta.url)),
                "replay",
                notificationFailureId,
                "--actor",
                "editor_1",
                "--lab",
                config.instanceId,
                "--request-id",
                requestId,
              ],
              {
                cwd: fileURLToPath(new URL("../../", import.meta.url)),
                env: { PATH: process.env.PATH },
                timeout: 30_000,
                maxBuffer: 65536,
              },
            )
          ).stdout,
        ) as { generation: number };
      } catch {
        throw new LabError("Owned recovery CLI failed; raw output withheld.");
      }
    };
    await cli();
    await cli();
    await poll("actual notification replay resolved", async () =>
      (await failures.get(notificationFailureId))?.resolvedGeneration === 1 ? true : undefined,
    );
    check(
      (await failures.get(notificationFailureId))!.recoveries.length === 1 &&
        (await pageAll("notifications", notificationId)).length === 1,
      "replay duplicated business delivery or cycle",
    );
    // Force marker loss: the business checks, not the transport cache, must reject duplicates/old facts.
    const settled = await succeeded(crashId);
    await clearMarker("publishContent", crashFact.eventId);
    await republish(crashFact);
    await poll("completed duplicate publisher marker", async () =>
      marker("publishContent", crashFact.eventId),
    );
    const oldReview = await committedFact(crashId, "contentItem.reviewRequested");
    const reviewId = settled.state.review!.reviewId;
    const beforeReview = await poll("approved review materialization", async () => {
      const review = await runtime.repository.getState("reviewTask", reviewId);
      return review && reviewTaskStateSchema.parse(review.state).status === "approved"
        ? review
        : undefined;
    });
    await clearMarker("materializeReview", oldReview.eventId);
    await republish(oldReview);
    await poll("old review marker", async () => marker("materializeReview", oldReview.eventId));
    check(
      (await runtime.repository.getState("reviewTask", reviewId))!.version ===
        beforeReview!.version,
      "out-of-order review downgraded state",
    );
    const published = await committedFact(crashId, "contentItem.published");
    await poll("all original crash notifications", async () =>
      (await pageAll("notifications", crashId)).length === 3 ? true : undefined,
    );
    await clearMarker("deliverNotification", published.eventId);
    await republish(published);
    await poll("duplicate notification marker", async () =>
      marker("deliverNotification", published.eventId),
    );
    check(
      (await pageAll("notifications", crashId)).length === 3 &&
        (await current(crashId)).version === settled.version,
      "duplicate changed business outcomes",
    );
    check((await oneArtifact(crashId)) === crashDigest, "duplicate changed stable object");
    await oneArtifact(transientId);
    await oneArtifact(terminalId);
    check((await pageAll("failures", terminalId)).length === 1, "missing paged failure summary");
    check(
      (await json(`/api/operations?view=attempts&contentId=${crashId}&cursor=invalid`)).status ===
        400,
      "invalid operations cursor accepted",
    );
    const missingRepository = new (await import("@jawstack/aws-runtime")).DynamoDbRepository({
      client: clients.dynamo,
      tableName: `${config.table}-absent`,
    });
    const missingApi = await startContentApi({
      runtime: { ...runtime, repository: missingRepository, close: () => undefined },
      port: 0,
    });
    try {
      const response = await fetch(`${missingApi.baseUrl}/api/resources/contentItem/${crashId}`, {
        headers: { "x-content-ops-fixture": "editor_1" },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.text();
      check(
        response.status >= 500 && !body.includes(config.table),
        "missing table produced empty success or leaked details",
      );
    } finally {
      await missingApi.close();
    }
    let missingObjectRejected = false;
    try {
      await createS3ObjectStore(clients.s3, `${config.bucket}-absent`).readPublication(
        settled.state.publication!.intent,
      );
    } catch (error) {
      missingObjectRejected =
        error instanceof Error && "code" in error && error.code === "runtime.unavailable";
    }
    check(missingObjectRejected, "missing storage did not fail explicitly");
    return {
      runId,
      mode: "real stream/bus/SQS/bundled application Lambdas with verification-only dependency faults",
      normalVisibilitySeconds: 180,
      clockAdvances: 0,
      hostWorkerInvocations: 0,
      transientRetry: true,
      crashAfterObjectAndLeaseExpiry: true,
      crashAttempts: attempts.length,
      terminalLambdaReceives: receives,
      collectorRecordBeforeAcknowledgement: true,
      failedCollectorRetainedSource: true,
      automaticCollectorRetry: true,
      applicationDlqsAcknowledged: true,
      editorRetryGeneration: 2,
      cliReplayCycles: 1,
      duplicatesAfterMarkerLoss: true,
      outOfOrderReviewIgnored: true,
      obsoleteGenerationAndLateCollectorIgnored: true,
      logicalArtifactsPerPublication: 1,
      uniqueCrashNotifications: 3,
      uniqueReplayedNotifications: 1,
      pagedOperationalQueries: true,
      missingServicesRejected: true,
      diagnostics: [
        "committed fact republish through EventBridge",
        "late original copy through the owned DLQ",
      ],
      standardCodeRestored: true,
    };
  } finally {
    try {
      await api.close();
    } finally {
      await restore();
    }
  }
}
