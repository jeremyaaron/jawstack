import { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryObjectStore,
  inspectAsset,
  readBoundedBytes,
  type AssetObjectStore,
} from "../../src/application/object-store";
import { createLocalS3ObjectStore } from "../../src/aws/object-store";
import { createLabConfig } from "../../src/lab/config";
import { assetObjectKey } from "../../src/shared/assets";
import { limits } from "../../src/shared/validation";
import { serializePublication } from "../../src/application/publication-artifact";
import { publicationHarness } from "../support/publication";

const contentId = "00000000-0000-4000-8000-000000000001";
const assetId = "00000000-0000-4000-8000-000000000002";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1kAAAAASUVORK5CYII=",
  "base64",
);
const target = { contentId, assetId, mediaType: "image/png" as const, expectedSize: png.length };
type Stored = {
  bytes: Uint8Array;
  type: string;
  digest: string;
  length?: number;
  metadata?: Record<string, string>;
};
function s3Harness() {
  const stored = new Map<string, Stored>();
  const commands: unknown[] = [];
  let conflicts = 0;
  let failure: string | undefined;
  const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: unknown) => {
    commands.push(command);
    if (failure) throw Object.assign(new Error("sensitive raw error"), { name: failure });
    if (command instanceof PutObjectCommand) {
      expect(command.input.IfNoneMatch).toBe("*");
      if (conflicts > 0) {
        conflicts--;
        throw Object.assign(new Error("race"), { name: "ConditionalRequestConflict" });
      }
      if (stored.has(command.input.Key!))
        throw Object.assign(new Error("exists"), { name: "PreconditionFailed" });
      stored.set(command.input.Key!, {
        bytes: Uint8Array.from(command.input.Body as Uint8Array),
        type: command.input.ContentType!,
        digest: command.input.Metadata!.sha256!,
        metadata: command.input.Metadata!,
      });
      return {} as never;
    }
    if (command instanceof GetObjectCommand) {
      const object = stored.get(command.input.Key!);
      if (!object) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return {
        Body: Readable.from([object.bytes]),
        ContentLength: object.length ?? object.bytes.byteLength,
        ContentType: object.type,
        Metadata: { ...object.metadata, sha256: object.digest },
      } as never;
    }
    throw new Error("Unexpected command");
  });
  const store = createLocalS3ObjectStore(createLabConfig());
  return {
    store,
    stored,
    commands,
    send,
    conflict: (count: number) => {
      conflicts = count;
    },
    fail: (name: string) => {
      failure = name;
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.each(["memory", "s3"] as const)("%s immutable publication store", (adapter) => {
  it("conditionally creates one exact artifact, recovers matching writes, and copies read bytes", async () => {
    const h = await publicationHarness();
    const store = adapter === "memory" ? h.app.objects : s3Harness().store;
    try {
      const expected = serializePublication(h.intent);
      const refs = await Promise.all(
        Array.from({ length: 4 }, () => store.createPublication(h.intent)),
      );
      expect(refs).toEqual(Array.from({ length: 4 }, () => expected.reference));
      const bytes = await store.readPublication(h.intent);
      bytes[0] = 0;
      expect(Buffer.from(await store.readPublication(h.intent))).toEqual(expected.bytes);
      const changed = { ...h.intent, snapshot: { ...h.intent.snapshot, body: "Changed bytes" } };
      await expect(store.createPublication(changed)).rejects.toMatchObject({
        failureCode: "artifact.mismatch",
      });
      expect(Buffer.from(await store.readPublication(h.intent))).toEqual(expected.bytes);
    } finally {
      if ("close" in store) (store.close as () => void)();
    }
  });
});

describe("publication S3 verification", () => {
  it("permits Lambda S3 only for the owned publisher on the fixed worker endpoint", () => {
    const config = createLabConfig("dev", "lambda");
    const send = vi.spyOn(S3Client.prototype, "send");
    expect(() => createLocalS3ObjectStore(config, { execution: "lambda" })).toThrow(
      "owned local publisher context",
    );
    vi.stubEnv("CONTENT_OPS_LAB_ID", "dev");
    vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "jawstack-content-ops-dev-worker");
    expect(() => createLocalS3ObjectStore(config, { execution: "lambda" })).toThrow(
      "owned local publisher context",
    );
    vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "jawstack-content-ops-dev-publisher");
    const store = createLocalS3ObjectStore(config, { execution: "lambda" });
    store.close();
    expect(() =>
      createLocalS3ObjectStore(
        { ...config, endpoint: "https://s3.amazonaws.com" },
        { execution: "lambda" },
      ),
    ).toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["bytes", "length", "type", "digest", "identity", "oversize"] as const)(
    "rejects %s corruption without overwriting",
    async (kind) => {
      const h = await publicationHarness();
      const s3 = s3Harness();
      try {
        const ref = await s3.store.createPublication(h.intent);
        const stored = s3.stored.get(ref.objectKey)!;
        if (kind === "bytes") stored.bytes[0] = 0;
        if (kind === "length") stored.length = ref.size - 1;
        if (kind === "type") stored.type = "text/html";
        if (kind === "digest") stored.digest = "0".repeat(64);
        if (kind === "identity") stored.metadata!.publicationid = "foreign";
        if (kind === "oversize") {
          stored.length = ref.size;
          stored.bytes = Uint8Array.from(Buffer.concat([stored.bytes, Buffer.from("x")]));
        }
        const before = structuredClone(stored);
        await expect(s3.store.createPublication(h.intent)).rejects.toMatchObject({
          failureCode: "artifact.mismatch",
        });
        expect(s3.stored.get(ref.objectKey)).toEqual(before);
      } finally {
        s3.store.close();
      }
    },
  );
  it("bounds conditional conflicts and sanitizes unknown SDK errors", async () => {
    const h = await publicationHarness();
    const s3 = s3Harness();
    try {
      s3.conflict(2);
      await expect(s3.store.createPublication(h.intent)).resolves.toEqual(
        serializePublication(h.intent).reference,
      );
      s3.conflict(10);
      const before = s3.commands.filter((c) => c instanceof PutObjectCommand).length;
      await expect(s3.store.createPublication(h.intent)).resolves.toEqual(
        serializePublication(h.intent).reference,
      );
      expect(s3.commands.filter((c) => c instanceof PutObjectCommand).length - before).toBe(3);
      s3.fail("AccessDenied");
      await expect(s3.store.createPublication(h.intent)).rejects.toMatchObject({
        failureCode: "storage.unavailable",
        message: "Publication execution failed (storage.unavailable).",
      });
    } finally {
      s3.store.close();
    }
  });
  it("does not interpret exhausted conflicts with no readable object as success", async () => {
    const h = await publicationHarness();
    const s3 = s3Harness();
    try {
      s3.conflict(10);
      await expect(s3.store.createPublication(h.intent)).rejects.toMatchObject({
        failureCode: "storage.unavailable",
      });
      expect(s3.commands.filter((c) => c instanceof PutObjectCommand)).toHaveLength(3);
    } finally {
      s3.store.close();
    }
  });
});

describe.each(["memory", "s3"] as const)("%s immutable asset object store", (adapter) => {
  const setup = () => (adapter === "memory" ? createMemoryObjectStore() : s3Harness().store);
  const close = (store: AssetObjectStore) => {
    if ("close" in store) (store.close as () => void)();
  };

  it("generates keys, verifies readback, isolates returned bytes, and accepts identical concurrent creation", async () => {
    const store = setup();
    try {
      const refs = await Promise.all(Array.from({ length: 4 }, () => store.create(target, png)));
      for (const ref of refs) expect(ref).toEqual(inspectAsset(target, png));
      expect(refs[0]!.objectKey).toBe(assetObjectKey(contentId, assetId));
      const bytes = await store.read(refs[0]!);
      bytes[0] = 0;
      expect(Buffer.from(await store.read(refs[0]!))).toEqual(png);
      expect("delete" in store).toBe(false);
    } finally {
      close(store);
    }
  });

  it("rejects different bytes at an existing key without overwriting it", async () => {
    const store = setup();
    try {
      const ref = await store.create(target, png);
      const changed = Buffer.from(png);
      changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
      await expect(store.create(target, changed)).rejects.toMatchObject({
        code: "resource.conflict",
      });
      expect(Buffer.from(await store.read(ref))).toEqual(png);
    } finally {
      close(store);
    }
  });

  it.each([
    { mediaType: "image/png" as const, bytes: png },
    { mediaType: "image/jpeg" as const, bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]) },
    { mediaType: "application/pdf" as const, bytes: Buffer.from("%PDF-1.7\n%%EOF\n") },
  ])(
    "detects the allowed $mediaType signature rather than trusting an extension",
    async ({ mediaType, bytes }) => {
      const store = setup();
      try {
        expect(
          await store.create({ ...target, mediaType, expectedSize: bytes.length }, bytes),
        ).toMatchObject({ mediaType, size: bytes.length });
      } finally {
        close(store);
      }
    },
  );

  it("rejects unknown signatures, mismatched claimed type/length, and high-bit PDF header spoofing", async () => {
    const store = setup();
    try {
      for (const bytes of [
        Buffer.alloc(png.length),
        Buffer.from("<html>evil</html>"),
        Buffer.from([0xa5, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]),
      ])
        await expect(
          store.create(
            { ...target, expectedSize: bytes.length, mediaType: "application/pdf" },
            bytes,
          ),
        ).rejects.toMatchObject({ code: "command.validation" });
      await expect(store.create({ ...target, mediaType: "image/jpeg" }, png)).rejects.toMatchObject(
        { code: "command.validation" },
      );
      await expect(
        store.create({ ...target, expectedSize: png.length - 1 }, png),
      ).rejects.toMatchObject({ code: "command.validation" });
      await expect(
        store.create({ ...target, contentId: "../../escape" }, png),
      ).rejects.toMatchObject({ code: "command.validation" });
    } finally {
      close(store);
    }
  });

  it("accepts exactly 10 MiB and rejects excess before persistence", async () => {
    const store = setup();
    try {
      const bytes = Buffer.alloc(limits.assetBytes);
      png.copy(bytes);
      expect((await store.create({ ...target, expectedSize: bytes.length }, bytes)).size).toBe(
        limits.assetBytes,
      );
      await expect(
        store.create(
          { ...target, expectedSize: limits.assetBytes + 1 },
          Buffer.alloc(limits.assetBytes + 1),
        ),
      ).rejects.toMatchObject({ code: "command.validation" });
    } finally {
      close(store);
    }
  });
});

describe("guarded S3 contracts and memory capacity", () => {
  it("rejects external endpoints, wrong buckets/region and inherited credentials before any send", () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    for (const config of [
      { ...createLabConfig(), endpoint: "https://s3.us-east-1.amazonaws.com" },
      { ...createLabConfig(), bucket: "someone-elses-bucket" },
      { ...createLabConfig(), region: "us-west-2" },
    ])
      expect(() => createLocalS3ObjectStore(config)).toThrow();
    vi.stubEnv("AWS_PROFILE", "real-account");
    expect(() => createLocalS3ObjectStore(createLabConfig())).toThrow("AWS_PROFILE");
    expect(send).not.toHaveBeenCalled();
  });

  it("bounds conditional 409 retries and checks existing bytes after a lost race", async () => {
    const h = s3Harness();
    try {
      h.conflict(2);
      expect(await h.store.create(target, png)).toEqual(inspectAsset(target, png));
      expect(h.commands.filter((c) => c instanceof PutObjectCommand)).toHaveLength(3);
      h.conflict(10);
      expect(await h.store.create(target, png)).toEqual(inspectAsset(target, png));
      expect(h.commands.filter((c) => c instanceof PutObjectCommand)).toHaveLength(6);
    } finally {
      h.store.close();
    }
  });

  it.each(["digest", "type", "bytes", "length", "stream"])(
    "rejects corrupt %s readback and never rewrites an object",
    async (corruption) => {
      const h = s3Harness();
      try {
        const ref = await h.store.create(target, png);
        const object = h.stored.get(ref.objectKey)!;
        if (corruption === "digest") object.digest = "0".repeat(64);
        if (corruption === "type") object.type = "text/html";
        if (corruption === "bytes") {
          object.bytes = Uint8Array.from(png);
          object.bytes[object.bytes.length - 1] = 0;
        }
        if (corruption === "length") object.length = png.length + 1;
        if (corruption === "stream") {
          object.bytes = Buffer.concat([png, Buffer.alloc(100)]);
          object.length = png.length;
        }
        await expect(h.store.read(ref)).rejects.toMatchObject({
          code: "resource.conflict",
        });
        expect(h.commands.filter((c) => c instanceof PutObjectCommand)).toHaveLength(1);
      } finally {
        h.store.close();
      }
    },
  );

  it("sanitizes unknown SDK failures", async () => {
    const h = s3Harness();
    try {
      h.fail("AccessDenied");
      await expect(h.store.create(target, png)).rejects.toMatchObject({
        code: "runtime.unavailable",
        message: "Conditional asset creation failed.",
      });
    } finally {
      h.store.close();
    }
  });

  it("bounds memory count/bytes but still permits a retry at capacity", async () => {
    const store = createMemoryObjectStore({ maxBytes: png.length, maxObjects: 1 });
    const ref = await store.create(target, png);
    expect(await store.create(target, png)).toEqual(ref);
    await expect(
      store.create({ ...target, assetId: "00000000-0000-4000-8000-000000000003" }, png),
    ).rejects.toMatchObject({ code: "runtime.unavailable" });
    expect(() => createMemoryObjectStore({ maxObjects: 0 })).toThrow();
    expect(() => createMemoryObjectStore({ maxBytes: 257 * 1024 * 1024 })).toThrow();
  });

  it("bounds streams, rejects non-byte chunks, and handles cancellation", async () => {
    const body = (async function* () {
      yield png.subarray(0, 8);
      yield png.subarray(8);
    })();
    expect(await readBoundedBytes(body, png.length)).toEqual(png);
    const invalid = (async function* () {
      yield "text" as unknown as Uint8Array;
    })();
    await expect(readBoundedBytes(invalid, 10)).rejects.toMatchObject({
      code: "command.validation",
    });
    const abort = new AbortController();
    abort.abort();
    await expect(readBoundedBytes(png, png.length, abort.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
