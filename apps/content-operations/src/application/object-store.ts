import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { JawStackRuntimeError } from "@jawstack/core";
import {
  assetObjectKey,
  mediaTypeSchema,
  objectReferenceSchema,
  type AssetSlot,
  type ObjectReference,
} from "../shared/assets";
import { idSchema, limits, instantSchema } from "../shared/validation";
import { cleanupObjectKey, objectObservationSchema, type AssetCleanupStore } from "./asset-cleanup";
import {
  PublicationExecutionError,
  serializePublication,
  verifyPublicationBytes,
  type PublicationObjectStore,
} from "./publication-artifact";

export type AssetTarget = Pick<AssetSlot, "contentId" | "assetId" | "mediaType" | "expectedSize">;
export type ByteSource = Uint8Array | AsyncIterable<Uint8Array>;
export interface AssetObjectStore {
  create(target: AssetTarget, bytes: Uint8Array): Promise<ObjectReference>;
  read(reference: ObjectReference): Promise<Uint8Array>;
}

export function inspectAsset(target: AssetTarget, bytes: Uint8Array): ObjectReference {
  if (
    !idSchema.safeParse(target.contentId).success ||
    !idSchema.safeParse(target.assetId).success ||
    !mediaTypeSchema.safeParse(target.mediaType).success ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > limits.assetBytes ||
    bytes.byteLength !== target.expectedSize
  )
    throw new JawStackRuntimeError("command.validation", "Invalid asset identity, type, or size.");
  const prefix = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 8));
  const detected =
    prefix.length >= 8 && prefix.equals(Buffer.from("89504e470d0a1a0a", "hex"))
      ? "image/png"
      : prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff
        ? "image/jpeg"
        : /^%PDF-(1\.[0-7]|2\.0)/.test(prefix.toString("latin1"))
          ? "application/pdf"
          : undefined;
  if (detected !== target.mediaType)
    throw new JawStackRuntimeError(
      "command.validation",
      "Bytes do not match an allowed media signature.",
    );
  return objectReferenceSchema.parse({
    contentId: target.contentId,
    assetId: target.assetId,
    objectKey: assetObjectKey(target.contentId, target.assetId),
    mediaType: detected,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

export function verifyStoredAsset(reference: ObjectReference, bytes: Uint8Array) {
  try {
    const actual = inspectAsset({ ...reference, expectedSize: reference.size }, bytes);
    if (actual.sha256 === reference.sha256) return;
  } catch {
    // Invalid stored bytes are a storage conflict, not new user input.
  }
  throw new JawStackRuntimeError(
    "resource.conflict",
    "Stored asset bytes differ; refusing overwrite.",
  );
}

export async function readBoundedBytes(source: ByteSource, maximum: number, signal?: AbortSignal) {
  const deadline = signal ?? AbortSignal.timeout(30_000);
  deadline.throwIfAborted();
  const stream = Readable.from(source instanceof Uint8Array ? [source] : source, {
    objectMode: true,
    signal: deadline,
  });
  const chunks: Buffer[] = [];
  let size = 0;
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(deadline.reason);
    deadline.addEventListener("abort", abort, { once: true });
    if (deadline.aborted) abort();
  });
  const reading = (async () => {
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array))
        throw new JawStackRuntimeError("command.validation", "Upload chunks must be bytes.");
      size += chunk.byteLength;
      if (size > maximum)
        throw new JawStackRuntimeError("command.validation", "Asset exceeds its byte limit.");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, size);
  })();
  try {
    // A producer may never settle next()/return(); cancellation must not wait for its cleanup.
    return await Promise.race([reading, cancelled]);
  } finally {
    deadline.removeEventListener("abort", abort);
    stream.destroy();
  }
}

export function createMemoryObjectStore(
  options: { maxBytes?: number; maxObjects?: number; clock?: () => Date } = {},
): AssetObjectStore & PublicationObjectStore & AssetCleanupStore {
  const maxBytes = options.maxBytes ?? 128 * 1024 * 1024;
  const maxObjects = options.maxObjects ?? 128;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 256 * 1024 * 1024 ||
    !Number.isSafeInteger(maxObjects) ||
    maxObjects < 1 ||
    maxObjects > 256
  )
    throw new Error("Invalid memory object-store capacity.");
  const objects = new Map<string, Uint8Array>();
  const observations = new Map<string, { lastModified: string; etag: string }>();
  let storedBytes = 0;
  const read = async (reference: ObjectReference) => {
    const ref = objectReferenceSchema.parse(reference);
    const bytes = objects.get(ref.objectKey);
    if (!bytes) throw new JawStackRuntimeError("resource.not_found", "Asset object was not found.");
    verifyStoredAsset(ref, bytes);
    return Uint8Array.from(bytes);
  };
  return {
    inspectAssetObject: async (target) => {
      const observed = observations.get(cleanupObjectKey(target));
      return observed && structuredClone(observed);
    },
    deleteAssetObject: async (target, observed, olderThan) => {
      objectObservationSchema.parse(observed);
      instantSchema.parse(olderThan);
      const key = cleanupObjectKey(target);
      const current = observations.get(key);
      if (
        !current ||
        current.etag !== observed.etag ||
        current.lastModified !== observed.lastModified ||
        current.lastModified > olderThan
      )
        return false;
      storedBytes -= objects.get(key)!.byteLength;
      objects.delete(key);
      observations.delete(key);
      return true;
    },
    readPublication: async (intent) => {
      const expected = serializePublication(intent);
      const bytes = objects.get(expected.reference.objectKey);
      if (!bytes) throw new PublicationExecutionError("storage.unavailable");
      verifyPublicationBytes(intent, bytes);
      return Uint8Array.from(bytes);
    },
    createPublication: async (intent) => {
      const expected = serializePublication(intent);
      if (!objects.has(expected.reference.objectKey)) {
        if (objects.size >= maxObjects || storedBytes + expected.bytes.length > maxBytes)
          throw new PublicationExecutionError("storage.unavailable");
        objects.set(expected.reference.objectKey, Uint8Array.from(expected.bytes));
        storedBytes += expected.bytes.length;
      }
      verifyPublicationBytes(intent, objects.get(expected.reference.objectKey)!);
      return expected.reference;
    },
    read,
    create: async (target, bytes) => {
      const ref = inspectAsset(target, bytes);
      if (!objects.has(ref.objectKey)) {
        if (objects.size >= maxObjects || storedBytes + bytes.byteLength > maxBytes)
          throw new JawStackRuntimeError(
            "runtime.unavailable",
            "Memory object-store capacity reached.",
          );
        const lastModified = (options.clock ?? (() => new Date()))().toISOString();
        objects.set(ref.objectKey, Uint8Array.from(bytes));
        observations.set(ref.objectKey, { lastModified, etag: ref.sha256 });
        storedBytes += bytes.byteLength;
      }
      await read(ref);
      return ref;
    },
  };
}
