import { beforeAll, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { contentLabProfile } from "../../scripts/lab-profile";
import { buildLab } from "../../scripts/build-lab";
import { createLabConfig, labFunctions, manifestSchema } from "../../src/lab/config";
import { applicationProfile } from "../../src/aws/profile";
import { contentServicePlan } from "../../src/lab/application-topology";
import { profileHash, verifyArchives } from "@jawstack/local-lab";

beforeAll(buildLab, 30_000);
it("preserves Content's subscriptions, bounds and explicit domain grants as data", () => {
  const config = createLabConfig("phase9"),
    app = applicationProfile(config),
    plan = contentServicePlan(config);
  expect(plan.functions).toHaveLength(13);
  expect(plan.mappings).toHaveLength(11);
  expect(plan.rules).toHaveLength(5);
  for (const f of app.functions) {
    expect(plan.functions.find((v) => v.name === f.name)).toMatchObject({
      timeout: 30,
      memory: 256,
      concurrency: 2,
    });
    const permissions = plan.roles
      .find((v) => v.name === f.name)!
      .statements.flatMap((s) => s.actions);
    if (!f.objects) expect(permissions.some((action) => action.startsWith("s3:"))).toBe(false);
    if (f.objects === "publication") {
      expect(permissions).toContain("s3:PutObject");
      expect(permissions).not.toContain("s3:DeleteObject");
    }
  }
  for (const worker of app.workers) {
    expect(plan.rules.find((r) => r.name === worker.rule)).toMatchObject({
      source: config.source,
      eventTypes: worker.eventTypes,
      queue: worker.queue,
    });
    expect(plan.queues.find((q) => q.name === worker.queue)).toMatchObject({
      visibility: 180,
      retention: 345600,
      receives: 3,
      dlq: worker.dlq,
    });
  }
});
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
