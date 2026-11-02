import { beforeAll, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { contentLabProfile } from "../../scripts/lab-profile";
import { buildLab } from "../../scripts/build-lab";
import { createLabConfig, labFunctions, manifestSchema } from "../../src/lab/config";
import { applicationProfile } from "../../src/aws/profile";
import { profileHash, verifyArchives } from "@jawstack/local-lab";

beforeAll(buildLab, 30_000);
it("registers all current Content functions/assets as finite shared lifecycle data", async () => {
  const config = createLabConfig("phase8");
  const profile = await contentLabProfile(
    fileURLToPath(new URL("../../", import.meta.url)),
    config,
  );
  expect(profile.functions.map((fn) => fn.name)).toEqual(
    [...labFunctions(config), ...applicationProfile(config).functions].map((fn) => fn.name),
  );
  expect(profile.resources.queues).toContain(applicationProfile(config).schedulerDlq);
  expect(profile.functions).toHaveLength(13);
  expect(new Set(profile.functions.map((fn) => fn.archive.path)).size).toBe(4);
  await verifyArchives(profile);
  expect(
    manifestSchema.safeParse({
      schemaVersion: 2,
      instanceId: config.instanceId,
      ownerId: "7dc55154-f37c-499a-90a6-841fbc0cbe1c",
      image: "wrong-image",
      status: "starting",
      architecture: "arm64",
      mappings: [],
      profile,
      profileHash: profileHash(profile),
      entitlement: { plan: "hobby", attestedAt: new Date().toISOString() },
    }).success,
  ).toBe(false);
});
