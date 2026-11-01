import { randomUUID } from "node:crypto";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createDynamoPersistence } from "../aws/persistence";
import { createLocalS3ObjectStore } from "../aws/object-store";
import { createContentDispatch } from "../application/dispatch";
import { createUploadService } from "../application/uploads";
import { inspectAsset } from "../application/object-store";
import { DynamoDbRepository } from "@jawstack/aws-runtime";
import { assetJanitorIdentity } from "../domain/resources";
import { fixtureAuth } from "../shared/identities";
import { type ContentState } from "../shared/contracts";
import { limits } from "../shared/validation";
import { LabError, type LabConfig } from "./config";
import type { LabClients } from "./clients";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new LabError(`Asset proof: ${message}`);
}
export async function verifyAssets(c: LabClients, config: LabConfig) {
  const runId = randomUUID();
  const contentId = randomUUID();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1kAAAAASUVORK5CYII=",
    "base64",
  );
  const repository = new DynamoDbRepository({ client: c.dynamo, tableName: config.table });
  const objects = createLocalS3ObjectStore(config);
  let now = new Date();
  const clock = () => new Date(now);
  const dispatch = createContentDispatch({
    persistence: createDynamoPersistence({ client: c.dynamo, tableName: config.table }),
    clock,
  });
  let sequence = 0;
  const run = (commandName: string, input: unknown, identity = fixtureAuth("author_1")) =>
    dispatch(
      {
        resourceType: "contentItem",
        resourceId: contentId,
        commandName,
        input,
        requestContext: {},
        idempotencyKey: `assets:${runId}:${++sequence}`,
      },
      identity,
    );
  const current = async () => (await repository.getState<ContentState>("contentItem", contentId))!;
  const register = async () => {
    check(
      (
        await run("registerAsset", {
          expectedVersion: (await current()).version,
          filename: "proof.png",
          mediaType: "image/png",
          expectedSize: png.length,
        })
      ).ok,
      "registration failed",
    );
    return (await current()).state.attachments.at(-1)!;
  };
  try {
    check(
      (
        await run("create", {
          title: "Immutable attachment proof",
          body: "Local-only upload recovery.",
        })
      ).ok,
      "create failed",
    );
    const slot = await register();
    const input = {
      contentId,
      assetId: slot.assetId,
      identity: fixtureAuth("author_1"),
      body: png,
    };
    const dueAt = new Date(now.getTime() + 86_400_000).toISOString();
    check(
      !(await run("submit", { expectedVersion: 2, assignedEditorId: "editor_1", dueAt })).ok,
      "pending upload submitted",
    );
    check(
      !(
        await run("registerAsset", {
          expectedVersion: 2,
          filename: "../escape.png",
          mediaType: "image/png",
          expectedSize: png.length,
        })
      ).ok,
      "path filename accepted",
    );
    let interrupted = true;
    const recovering = createUploadService({
      repository,
      objects,
      clock,
      dispatch: async (request, identity) => {
        if (interrupted) {
          interrupted = false;
          return {
            ok: false,
            error: { code: "runtime.unavailable", message: "Injected completion interruption" },
            meta: { requestId: runId, correlationId: runId },
          };
        }
        return dispatch(request, identity);
      },
    });
    let failed = false;
    try {
      await recovering(input);
    } catch {
      failed = true;
    }
    check(
      failed && (await current()).state.attachments[0]?.status === "pending",
      "interrupted upload became ready",
    );
    const ref = inspectAsset(slot, png);
    check(
      Buffer.from(await objects.read(ref)).equals(png),
      "object was not durable before completion",
    );
    const changed = Buffer.from(png);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    let mismatch = false;
    try {
      await recovering({ ...input, body: changed });
    } catch {
      mismatch = true;
    }
    check(
      mismatch && (await current()).state.attachments[0]?.status === "pending",
      "different bytes were accepted",
    );
    const ready = await recovering(input);
    check(
      ready.status === "ready" && ready.verified?.sha256 === ref.sha256,
      "retry did not recover verification",
    );
    const version = (await current()).version;
    const repeated = await recovering(input);
    check(
      repeated.verified?.sha256 === ref.sha256 && (await current()).version === version,
      "matching retry mutated ready state",
    );
    const duplicate = await Promise.all(Array.from({ length: 4 }, () => objects.create(slot, png)));
    check(
      duplicate.every((object) => object.sha256 === ref.sha256),
      "concurrent conditional object writes diverged",
    );
    const listed = await c.s3.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: `assets/${contentId}/${slot.assetId}/`,
      }),
    );
    check(listed.Contents?.length === 1, "more than one logical object");
    check(
      (await run("submit", { expectedVersion: version, assignedEditorId: "editor_1", dueAt })).ok,
      "ready submission failed",
    );
    const submitted = await current();
    check(
      submitted.state.review?.submitted.attachments[0]?.sha256 === ref.sha256,
      "review did not freeze verified object reference",
    );
    check(
      (
        await run(
          "approve",
          {
            expectedVersion: submitted.version,
            reviewId: submitted.state.review!.reviewId,
            revisionId: submitted.state.revisionId,
            note: "Approved immutable upload",
          },
          fixtureAuth("editor_1"),
        )
      ).ok,
      "approval failed",
    );
    let locked = false;
    try {
      await recovering(input);
    } catch {
      locked = true;
    }
    check(locked, "approved content allowed upload");
    check(
      (await run("reopenDraft", { expectedVersion: (await current()).version })).ok,
      "reopen failed",
    );
    check(
      (
        await run("removeAsset", {
          expectedVersion: (await current()).version,
          assetId: slot.assetId,
        })
      ).ok,
      "removal failed",
    );
    check(
      (await current()).state.attachments[0]?.status === "removed" &&
        Buffer.from(await objects.read(ref)).equals(png),
      "removal broke historical object reference",
    );
    const pending = await register();
    now = new Date(now.getTime() + limits.uploadLifetimeMs);
    let expired = false;
    try {
      await recovering({ ...input, assetId: pending.assetId });
    } catch {
      expired = true;
    }
    check(expired, "expired pending slot accepted bytes");
    check(
      (
        await run(
          "expireAsset",
          { expectedVersion: (await current()).version, assetId: pending.assetId },
          {
            subject: assetJanitorIdentity.subject,
            roles: [assetJanitorIdentity.role],
            claims: {},
            mode: "test",
          },
        )
      ).ok,
      "expiry tombstone failed",
    );
    check(
      (await current()).state.attachments.at(-1)?.status === "expired",
      "missing expiry tombstone",
    );
    const absent = await c.s3.send(
      new ListObjectsV2Command({ Bucket: config.bucket, Prefix: pending.objectKey }),
    );
    check(!absent.Contents?.length, "expired slot wrote an object");

    // These are bounded signature fixtures, not a claim of full JPEG/PDF decoding or sanitization.
    for (const fixture of [
      {
        mediaType: "image/jpeg" as const,
        bytes: Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex"),
      },
      {
        mediaType: "application/pdf" as const,
        bytes: Buffer.from("%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n"),
      },
    ]) {
      const target = {
        contentId,
        assetId: randomUUID(),
        mediaType: fixture.mediaType,
        expectedSize: fixture.bytes.length,
      };
      const object = await objects.create(target, fixture.bytes);
      check(
        Buffer.from(await objects.read(object)).equals(fixture.bytes),
        "allowed signature readback failed",
      );
    }
    return {
      runId,
      contentId,
      allowedSignatures: ["image/png", "image/jpeg", "application/pdf"],
      conditionalCreators: 4,
      logicalOriginalObjects: 1,
      objectBeforeCompletion: true,
      interruptedCompletionRecovery: true,
      mismatchedBytesRejected: true,
      matchingRetryNoMutation: true,
      pendingSubmissionRejected: true,
      generatedKeyAndSafeFilename: true,
      frozenReviewReference: true,
      approvedUploadRejected: true,
      removedReferenceRetained: true,
      expiryTombstone: true,
      expiredSlotNoObject: true,
    };
  } finally {
    objects.close();
  }
}
