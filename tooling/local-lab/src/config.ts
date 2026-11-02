import { z } from "zod";
import { copyWorkflowJson } from "@jawstack/core";

export const localstackImage =
  "localstack/localstack:2026.10.0@sha256:aa5632e041ca54ff61a0a25e17b1c898b09a1eb7f611bfc05f73ef53b7266872";
export const hostEndpoint = "http://127.0.0.1:4566";
export class LabError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabError";
  }
}
export function assertCleanAwsEnvironment(env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(env)) {
    if (!value || !key.startsWith("AWS_")) continue;
    if (["AWS_REGION", "AWS_DEFAULT_REGION"].includes(key) && value === "us-east-1") continue;
    if (key === "AWS_EC2_METADATA_DISABLED" && value === "true") continue;
    throw new LabError(`Remove inherited ${key} before running the isolated lab.`);
  }
}
const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/);
const names = z.array(name).max(200);
export const profileSchema = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: z.string().regex(/^[a-z][a-z0-9-]{0,15}$/),
    project: z.string().regex(/^jawstack-[a-z][a-z0-9-]{0,45}$/),
    functions: z
      .array(
        z
          .object({
            name,
            handler: z.string().regex(/^index\.[A-Za-z][A-Za-z0-9]*$/),
            archive: z
              .object({
                path: z.string().min(1).max(4096),
                sha256: z.string().regex(/^[a-f0-9]{64}$/),
              })
              .strict(),
          })
          .strict(),
      )
      .max(100),
    resources: z
      .object({
        tables: names,
        buses: names,
        queues: names,
        roles: names,
        buckets: names,
        scheduleGroups: names,
      })
      .strict(),
  })
  .strict()
  .superRefine((p, ctx) => {
    for (const list of [p.functions.map((f) => f.name), ...Object.values(p.resources)]) {
      if (
        new Set(list.map((n) => n.toLowerCase())).size !== list.length ||
        list.some((n) => !n.startsWith(`${p.project}-`))
      )
        ctx.addIssue({
          code: "custom",
          message: "Inventory must have unique project-prefixed names.",
        });
    }
  });
export type LabProfile = z.infer<typeof profileSchema>;
export type RuntimeProfile = Readonly<{
  project: string;
  functions: readonly Readonly<{ name: string }>[];
}>;

export function parseProfile(input: unknown): LabProfile {
  try {
    const profile = profileSchema.parse(copyWorkflowJson(input, 64 * 1024));
    const freeze = (value: unknown): void => {
      if (value && typeof value === "object") {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    };
    freeze(profile);
    return profile;
  } catch {
    throw new LabError("Invalid bounded lab profile; refusing operation.");
  }
}
const fields = {
  instanceId: z.string().regex(/^[a-z][a-z0-9-]{0,15}$/),
  ownerId: z.uuid(),
  image: z.literal(localstackImage),
  status: z.enum(["starting", "provisioning", "ready"]),
  architecture: z.enum(["arm64", "x86_64"]),
  queueUrl: z.string().max(2048).optional(),
  streamArn: z.string().max(2048).optional(),
  mappings: z.array(z.string().min(1).max(128)).max(200).default([]),
  capabilitiesVersion: z.literal(1).optional(),
  applicationVersion: z.literal(1).optional(),
  runtimeOwnershipVersion: z.literal(1).optional(),
};
export const legacyManifestSchema = z.object({ schemaVersion: z.literal(1), ...fields }).strict();
export const currentManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    ...fields,
    profile: profileSchema,
    profileHash: z.string().regex(/^[a-f0-9]{64}$/),
    entitlement: z.object({ plan: z.literal("hobby"), attestedAt: z.iso.datetime() }).strict(),
  })
  .strict();
export const manifestSchema = z.discriminatedUnion("schemaVersion", [
  legacyManifestSchema,
  currentManifestSchema,
]);
export type LabManifest = z.infer<typeof manifestSchema>;
