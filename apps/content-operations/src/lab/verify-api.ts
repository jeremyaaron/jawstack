import { randomUUID } from "node:crypto";
import { createLocalstackApiRuntime } from "../aws/api-runtime";
import { startContentApi } from "../http/server";
import { LabError, type LabConfig } from "./config";
import { waitFor } from "./lifecycle";
import { contentStateSchema, reviewTaskStateSchema } from "../shared/contracts";
import { assetSlotSchema } from "../shared/assets";
import { notificationSchema } from "../application/notifications";
import { publicationOperationSchema } from "../application/publication-operations";
import { serializePublication } from "../application/publication-artifact";
import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { outboxEventKey, workerIdempotencyKey } from "@jawstack/aws-runtime";
import { createClients, destroyClients } from "./clients";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new LabError(`HTTP proof: ${message}`);
}

export async function verifyApi(config: LabConfig) {
  const runtime = await createLocalstackApiRuntime({ labId: config.instanceId });
  const api = await startContentApi({ runtime, port: 0 });
  const clients = createClients(config);
  try {
    const json = async (path: string, input?: unknown, actor = "author_1") => {
      const response = await fetch(`${api.baseUrl}${path}`, {
        method: input === undefined ? "GET" : "POST",
        headers: { "x-content-ops-fixture": actor, "content-type": "application/json" },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      const body = (await response.json()) as { ok: boolean; data: Record<string, unknown> };
      check(
        !/objectKey|fencingToken|accessKeyId|secretAccessKey|bucket|endpoint/.test(
          JSON.stringify(body),
        ),
        "private storage metadata escaped",
      );
      return { status: response.status, body };
    };
    const command = (name: string, input: unknown, id?: string, actor?: string) =>
      json(
        `/api/resources/contentItem/${id ? `${id}/` : ""}commands/${name}`,
        { input, idempotencyKey: randomUUID() },
        actor,
      );
    const health = await json("/api/health");
    check(
      health.body.data.runtime === "localstack" &&
        health.body.data.processing === "external-workers",
      "wrong runtime or hidden host pump",
    );
    const created = await command("create", {
      title: "Live HTTP proof",
      body: "Private local DynamoDB/S3 ingress.",
    });
    check(created.body.ok, "create failed");
    const id = created.body.data.resourceId as string;
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1kAAAAASUVORK5CYII=",
      "base64",
    );
    const registered = await command(
      "registerAsset",
      {
        expectedVersion: 1,
        filename: "proof.png",
        mediaType: "image/png",
        expectedSize: bytes.length,
      },
      id,
    );
    check(registered.body.ok, "register failed");
    const assetId = registered.body.data.assetId as string;
    const downloadPath = `/api/assets/${assetId}/download?contentId=${id}`;
    check((await json(downloadPath)).status === 404, "pending slot downloadable");
    const uploaded = await fetch(`${api.baseUrl}/api/uploads/${id}/${assetId}`, {
      method: "PUT",
      headers: { "x-content-ops-fixture": "author_1", "content-type": "image/png" },
      body: bytes,
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    check(uploaded.ok, "upload failed");
    const uploadBody = await uploaded.text();
    check(
      !/objectKey|fencingToken|bucket|endpoint/.test(uploadBody),
      "upload leaked storage metadata",
    );
    const downloaded = await fetch(`${api.baseUrl}${downloadPath}`, {
      headers: { "x-content-ops-fixture": "author_2" },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    check(
      downloaded.ok && Buffer.from(await downloaded.arrayBuffer()).equals(bytes),
      "verified bytes differ",
    );
    const current = await json(`/api/resources/contentItem/${id}`);
    check(current.body.ok, "strong resource read failed");
    const stored = await runtime.repository.getState("contentItem", id);
    check(
      stored?.version === (current.body.data.resource as { version: number }).version,
      "HTTP response differs from DynamoDB authority",
    );
    const listed = await json("/api/content?status=draft&title=Live%20HTTP%20proof&limit=100");
    check(
      listed.body.ok &&
        (listed.body.data.items as { itemId: string }[]).some((item) => item.itemId === id),
      "bounded projection query failed",
    );
    check(
      (await command("editDraft", { expectedVersion: 1, title: "Stale", body: "Body" }, id))
        .status === 409,
      "stale command accepted",
    );
    check(
      (await command("completeUpload", {}, id, "editor_1")).status === 403,
      "internal command exposed",
    );
    check(
      (
        await command(
          "editDraft",
          { expectedVersion: stored!.version, title: "Theft", body: "Body" },
          id,
          "author_2",
        )
      ).status === 403,
      "ownership bypass",
    );
    check(
      (await json(`/api/content/${id}/publication`)).status === 404,
      "uncommitted preview available",
    );
    const currentContent = async () => {
      const row = await runtime.repository.getState("contentItem", id);
      check(row, "missing authoritative content");
      return { ...row, state: contentStateSchema.parse(row.state) };
    };
    await waitFor("actual asset materializer Lambda", async () => {
      const row = await runtime.repository.getState("asset", assetId);
      return row && assetSlotSchema.parse(row.state).status === "ready" ? row : undefined;
    });
    check(
      (
        await command(
          "submit",
          {
            expectedVersion: (await currentContent()).version,
            assignedEditorId: "editor_1",
            dueAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
          id,
        )
      ).body.ok,
      "submit failed",
    );
    const submitted = await currentContent();
    const reviewId = submitted.state.review!.reviewId;
    await waitFor("actual review materializer Lambda", async () => {
      const row = await runtime.repository.getState("reviewTask", reviewId);
      return row && reviewTaskStateSchema.parse(row.state).status === "pending" ? row : undefined;
    });
    check(
      (
        await command(
          "approve",
          {
            expectedVersion: submitted.version,
            reviewId,
            revisionId: submitted.state.revisionId,
            note: "Live deployed application proof.",
          },
          id,
          "editor_1",
        )
      ).body.ok,
      "approve failed",
    );
    const approved = await currentContent();
    const scheduledAt = new Date(Date.now() + 5_000).toISOString();
    check(
      (
        await command(
          "schedule",
          {
            expectedVersion: approved.version,
            reviewId,
            revisionId: approved.state.revisionId,
            scheduledAt,
            timeZone: "UTC",
          },
          id,
          "editor_1",
        )
      ).body.ok,
      "schedule failed",
    );
    const published = await waitFor(
      "automatic due-publication Scheduler and publisher Lambda",
      async () => {
        const row = await currentContent();
        return row.state.status === "published" ? row : undefined;
      },
      180_000,
    );
    check(published.state.publication?.phase === "succeeded", "missing publication completion");
    const expected = serializePublication(published.state.publication.intent);
    const artifact = await runtime.objects.readPublication(published.state.publication.intent);
    check(
      Buffer.from(artifact).equals(expected.bytes),
      "publisher artifact differs from frozen intent",
    );
    const list = await clients.s3.send(
      new ListObjectsV2Command({ Bucket: config.bucket, Prefix: `publications/${id}/` }),
    );
    check(!list.IsTruncated && list.Contents?.length === 1, "expected one logical artifact");
    const preview = await json(`/api/content/${id}/publication`);
    check(preview.body.ok, "published preview unavailable");
    const notifications = await waitFor("actual notification Lambda outcomes", async () => {
      const result = await json(
        `/api/operations?view=notifications&contentId=${id}&limit=100`,
        undefined,
        "editor_1",
      );
      check(result.body.ok, "notification query failed");
      const deliveries = (result.body.data.items as { data: unknown }[]).map((row) =>
        notificationSchema.parse(row.data),
      );
      return [
        "contentItem.reviewRequested",
        "contentItem.reviewDecided",
        "contentItem.published",
      ].every((type) => deliveries.some((row) => row.eventType === type))
        ? deliveries
        : undefined;
    });
    check(
      notifications.length === 3 && new Set(notifications.map((row) => row.deliveryId)).size === 3,
      "duplicate or missing business notifications",
    );
    const attempts = await waitFor("succeeded attempt projection", async () => {
      const result = await json(
        `/api/operations?view=attempts&contentId=${id}&limit=100`,
        undefined,
        "editor_1",
      );
      check(result.body.ok, "attempt query failed");
      const rows = (result.body.data.items as { data: unknown }[]).map((row) =>
        publicationOperationSchema.parse(row.data),
      );
      return rows.length === 1 && rows[0]!.attempt.status === "succeeded" ? rows : undefined;
    });
    const outcome = notifications.find((row) => row.eventType === "contentItem.published")!;
    const record = async (key: Record<string, string>) => {
      const result = await clients.dynamo.send(
        new GetItemCommand({ TableName: config.table, Key: marshall(key), ConsistentRead: true }),
      );
      return result.Item ? unmarshall(result.Item) : undefined;
    };
    await waitFor("actual outcome outbox publication marker", async () =>
      (await record(outboxEventKey(outcome.sourceEventId)))?.status === "PUBLISHED"
        ? true
        : undefined,
    );
    await waitFor("actual notification completion marker", async () =>
      record(workerIdempotencyKey("deliverNotification", outcome.transportEventId)),
    );
    return {
      contentId: id,
      runtime: "localstack",
      processing: "external-workers",
      ownedPrivateBucketGuard: true,
      actualDynamoAuthority: true,
      boundedProjectionQuery: true,
      realS3UploadDownload: true,
      pendingDownloadRejected: true,
      privateMetadataExcluded: true,
      staleConflict: true,
      internalCommandDenied: true,
      authorOwnershipEnforced: true,
      uncommittedPreviewRejected: true,
      consumerWorkerDeployment: true,
      materializedAssetId: assetId,
      materializedReviewId: reviewId,
      scheduler: { trigger: "automatic rate(1 minute)", scheduledAt },
      publicationId: published.state.publication.intent.publicationId,
      logicalArtifacts: 1,
      digest: expected.reference.sha256,
      notificationDeliveries: notifications.length,
      succeededAttempts: attempts.length,
      outboxPublishedAndWorkerMarked: true,
    };
  } finally {
    destroyClients(clients);
    await api.close();
  }
}
