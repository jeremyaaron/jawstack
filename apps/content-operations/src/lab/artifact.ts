import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { LabError, type LabConfig } from "./config";
import type { LabClients } from "./clients";

export const proofArtifact = (resourceId: string, eventId: string, message: string) =>
  JSON.stringify({ schemaVersion: 1, resourceId, eventId, message });

export async function putProofArtifact(
  c: Pick<LabClients, "s3">,
  config: LabConfig,
  key: string,
  body: string,
) {
  if (!/^proofs\/[a-zA-Z0-9_-]+\.json$/.test(key) || Buffer.byteLength(body) > 1024)
    throw new LabError("Invalid proof artifact.");
  const digest = createHash("sha256").update(body).digest("hex");
  let created = true;
  try {
    await c.s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
        Metadata: { sha256: digest },
        IfNoneMatch: "*",
      }),
    );
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "PreconditionFailed") throw error;
    created = false;
  }
  const object = await c.s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
  if ((object.ContentLength ?? Infinity) > 1024 || !object.Body)
    throw new LabError("Invalid stored proof artifact size.");
  const stored = await object.Body.transformToString();
  if (stored !== body || object.Metadata?.sha256 !== digest)
    throw new LabError("Stored proof artifact digest/content mismatch; refusing overwrite.");
  return { key, digest, created };
}
