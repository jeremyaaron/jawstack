import { randomUUID } from "node:crypto";
import {
  HeadObjectCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalS3ObjectStore } from "../../src/aws/object-store";
import { createMemoryObjectStore } from "../../src/application/object-store";
import { createLabConfig } from "../../src/lab/config";
import { png } from "../support/editorial";

const target = { contentId: randomUUID(), assetId: randomUUID() };
const observed = { lastModified: "2026-10-30T12:00:00.000Z", etag: '"abc123"' };
const olderThan = "2026-10-31T12:00:00.000Z";
afterEach(() => vi.restoreAllMocks());
describe("exact-key cleanup adapters", () => {
  it("deletes an unchanged old S3 asset conditionally in the owned unversioned bucket", async () => {
    const commands: unknown[] = [];
    const send = vi
      .spyOn(S3Client.prototype, "send")
      .mockImplementation(async (command: unknown) => {
        commands.push(command);
        if (command instanceof HeadObjectCommand)
          return { LastModified: new Date(observed.lastModified), ETag: observed.etag } as never;
        if (command instanceof GetBucketVersioningCommand) return {} as never;
        if (command instanceof DeleteObjectCommand) {
          expect(command.input).toMatchObject({
            Bucket: createLabConfig().bucket,
            Key: `assets/${target.contentId}/${target.assetId}/original`,
            IfMatch: observed.etag,
          });
          return {} as never;
        }
        throw new Error("Unexpected cleanup command");
      });
    const store = createLocalS3ObjectStore(createLabConfig());
    try {
      expect(await store.deleteAssetObject(target, observed, olderThan)).toBe(true);
      expect(send).toHaveBeenCalledTimes(3);
      expect(commands.filter((c) => c instanceof DeleteObjectCommand)).toHaveLength(1);
    } finally {
      store.close();
    }
  });
  it.each([
    "changed",
    "young",
    "versioned",
    "suspended",
    "precondition",
    "missing",
    "malformed",
    "failure",
  ] as const)("handles %s without unsafe deletion", async (mode) => {
    let deleted = false;
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
      if (mode === "failure") throw new Error("sensitive SDK failure");
      if (command instanceof HeadObjectCommand) {
        if (mode === "missing") throw Object.assign(new Error("gone"), { name: "NotFound" });
        return {
          LastModified:
            mode === "malformed"
              ? undefined
              : new Date(mode === "young" ? "2026-11-01T00:00:00.000Z" : observed.lastModified),
          ETag: mode === "changed" ? '"other"' : observed.etag,
        } as never;
      }
      if (command instanceof GetBucketVersioningCommand)
        return {
          Status: mode === "versioned" ? "Enabled" : mode === "suspended" ? "Suspended" : undefined,
        } as never;
      if (command instanceof DeleteObjectCommand) {
        if (mode === "precondition")
          throw Object.assign(new Error("changed"), { name: "PreconditionFailed" });
        deleted = true;
        return {} as never;
      }
      throw new Error("Unexpected cleanup command");
    });
    const store = createLocalS3ObjectStore(createLabConfig());
    try {
      if (["versioned", "suspended", "malformed", "failure"].includes(mode))
        await expect(store.deleteAssetObject(target, observed, olderThan)).rejects.toThrow();
      else expect(await store.deleteAssetObject(target, observed, olderThan)).toBe(false);
      expect(deleted).toBe(false);
    } finally {
      store.close();
    }
  });
  it("rejects forged keys, wildcard conditions and young observations before any SDK operation", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    const store = createLocalS3ObjectStore(createLabConfig());
    try {
      await expect(
        store.deleteAssetObject({ ...target, assetId: "../publication" }, observed, olderThan),
      ).rejects.toThrow();
      await expect(
        store.deleteAssetObject(target, { ...observed, etag: "*" }, olderThan),
      ).rejects.toThrow();
      expect(
        await store.deleteAssetObject(
          target,
          { ...observed, lastModified: "2026-11-01T00:00:00.000Z" },
          olderThan,
        ),
      ).toBe(false);
      expect(send).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
  it("memory deletion checks identity/age, is repeat-safe, and restores the capacity budget", async () => {
    const store = createMemoryObjectStore({
      maxObjects: 1,
      clock: () => new Date(observed.lastModified),
    });
    await store.create({ ...target, mediaType: "image/png", expectedSize: png.length }, png);
    const head = (await store.inspectAssetObject(target))!;
    expect(await store.deleteAssetObject(target, { ...head, etag: "different" }, olderThan)).toBe(
      false,
    );
    expect(await store.deleteAssetObject(target, head, "2026-10-29T12:00:00.000Z")).toBe(false);
    expect(await store.deleteAssetObject(target, head, olderThan)).toBe(true);
    expect(await store.deleteAssetObject(target, head, olderThan)).toBe(false);
    expect(await store.inspectAssetObject(target)).toBeUndefined();
    await expect(
      store.create(
        { ...target, assetId: randomUUID(), mediaType: "image/png", expectedSize: png.length },
        png,
      ),
    ).resolves.toBeDefined();
  });
});
