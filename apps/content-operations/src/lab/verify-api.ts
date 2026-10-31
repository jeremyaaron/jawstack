import { randomUUID } from "node:crypto";
import { createLocalstackApiRuntime } from "../aws/api-runtime";
import { startContentApi } from "../http/server";
import { LabError, type LabConfig } from "./config";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new LabError(`HTTP proof: ${message}`);
}

export async function verifyApi(config: LabConfig) {
  const runtime = await createLocalstackApiRuntime({ labId: config.instanceId });
  const api = await startContentApi({ runtime, port: 0 });
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
      consumerWorkerDeployment: false,
    };
  } finally {
    await api.close();
  }
}
