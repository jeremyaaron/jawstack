import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { JawStackRuntimeError } from "@jawstack/core";
import { objectReferenceSchema } from "../shared/assets";
import type { PublicationIntent } from "../shared/contracts";
import {
  inspectAsset,
  readBoundedBytes,
  verifyStoredAsset,
  type AssetObjectStore,
} from "../application/object-store";
import { LocalOnlyHttpHandler } from "../lab/clients";
import {
  PublicationExecutionError,
  serializePublication,
  verifyPublicationBytes,
  type PublicationObjectStore,
} from "../application/publication-artifact";
import {
  assertCleanAwsEnvironment,
  createLabConfig,
  LabError,
  validateEndpoint,
  hostEndpoint,
  workerEndpoint,
} from "../lab/config";

export function createLocalS3ObjectStore(
  config: Readonly<{ instanceId: string; endpoint: string; region: string; bucket: string }>,
  options: { execution?: "host" | "lambda" } = {},
): AssetObjectStore & PublicationObjectStore & { close(): void } {
  if ((options.execution ?? "host") === "host") {
    assertCleanAwsEnvironment(process.env);
    if (config.endpoint !== hostEndpoint)
      throw new LabError("Host object stores require the loopback endpoint.");
  } else if (
    config.endpoint !== workerEndpoint ||
    process.env.CONTENT_OPS_LAB_ID !== config.instanceId ||
    process.env.AWS_LAMBDA_FUNCTION_NAME !== `jawstack-content-ops-${config.instanceId}-publisher`
  ) {
    throw new LabError("Lambda object store requires the owned local publisher context.");
  }
  validateEndpoint(config.endpoint);
  const expected = createLabConfig(config.instanceId);
  if (config.bucket !== expected.bucket || config.region !== expected.region)
    throw new LabError("Asset store requires the owned local bucket and region.");
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    maxAttempts: 2,
    forcePathStyle: true,
    followRegionRedirects: false,
    requestHandler: new LocalOnlyHttpHandler(config.endpoint),
  });
  const read: AssetObjectStore["read"] = async (reference) => {
    const ref = objectReferenceSchema.parse(reference);
    try {
      const object = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: ref.objectKey }),
      );
      if (
        !object.Body ||
        object.ContentLength !== ref.size ||
        object.ContentType !== ref.mediaType ||
        object.Metadata?.sha256 !== ref.sha256
      ) {
        if (object.Body && "destroy" in object.Body) object.Body.destroy();
        throw new JawStackRuntimeError(
          "resource.conflict",
          "Stored asset metadata differs; refusing overwrite.",
        );
      }
      if (!(Symbol.asyncIterator in object.Body))
        throw new JawStackRuntimeError(
          "runtime.unavailable",
          "Asset response is not a bounded byte stream.",
        );
      const bytes = await readBoundedBytes(object.Body as AsyncIterable<Uint8Array>, ref.size);
      verifyStoredAsset(ref, bytes);
      return bytes;
    } catch (error) {
      if (error instanceof JawStackRuntimeError && error.code === "command.validation")
        throw new JawStackRuntimeError(
          "resource.conflict",
          "Stored asset exceeded its verified byte limit.",
        );
      if (error instanceof JawStackRuntimeError) throw error;
      throw new JawStackRuntimeError("runtime.unavailable", "Asset readback failed.");
    }
  };
  const readPublication = async (intent: PublicationIntent) => {
    const expected = serializePublication(intent);
    try {
      const object = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: expected.reference.objectKey }),
      );
      if (
        !object.Body ||
        object.ContentLength !== expected.reference.size ||
        object.ContentType !== "application/json" ||
        object.Metadata?.sha256 !== expected.reference.sha256 ||
        object.Metadata?.contentid !== intent.contentId ||
        object.Metadata?.publicationid !== intent.publicationId
      ) {
        if (object.Body && "destroy" in object.Body) object.Body.destroy();
        throw new PublicationExecutionError("artifact.mismatch");
      }
      if (!(Symbol.asyncIterator in object.Body))
        throw new PublicationExecutionError("storage.unavailable");
      const bytes = await readBoundedBytes(
        object.Body as AsyncIterable<Uint8Array>,
        expected.reference.size,
      );
      verifyPublicationBytes(intent, bytes);
      return bytes;
    } catch (error) {
      if (error instanceof PublicationExecutionError) throw error;
      if (error instanceof JawStackRuntimeError && error.code === "command.validation")
        throw new PublicationExecutionError("artifact.mismatch");
      throw new PublicationExecutionError("storage.unavailable");
    }
  };
  return {
    createPublication: async (intent) => {
      const expected = serializePublication(intent);
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await client.send(
              new PutObjectCommand({
                Bucket: config.bucket,
                Key: expected.reference.objectKey,
                Body: expected.bytes,
                ContentType: "application/json",
                Metadata: {
                  sha256: expected.reference.sha256,
                  contentid: intent.contentId,
                  publicationid: intent.publicationId,
                },
                IfNoneMatch: "*",
              }),
            );
            break;
          } catch (error) {
            const name = error instanceof Error ? error.name : "unknown";
            if (name === "PreconditionFailed") break;
            if (name !== "ConditionalRequestConflict") throw error;
          }
        }
        await readPublication(intent);
        return expected.reference;
      } catch (error) {
        if (error instanceof PublicationExecutionError) throw error;
        throw new PublicationExecutionError("storage.unavailable");
      }
    },
    readPublication,
    read,
    close: () => client.destroy(),
    create: async (target, bytes) => {
      // Snapshot before an SDK await so caller mutation cannot change the bytes behind the digest.
      const ref = inspectAsset(target, bytes);
      const body = Uint8Array.from(bytes);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await client.send(
            new PutObjectCommand({
              Bucket: config.bucket,
              Key: ref.objectKey,
              Body: body,
              ContentType: ref.mediaType,
              Metadata: { sha256: ref.sha256 },
              IfNoneMatch: "*",
            }),
          );
          break;
        } catch (error) {
          const name = error instanceof Error ? error.name : "unknown";
          if (name === "PreconditionFailed") break;
          if (name !== "ConditionalRequestConflict")
            throw new JawStackRuntimeError(
              "runtime.unavailable",
              "Conditional asset creation failed.",
            );
        }
      }
      await read(ref);
      return ref;
    },
  };
}
