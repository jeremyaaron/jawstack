import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { buildLab } from "../../scripts/build-lab";
import { applicationProfile } from "../../src/aws/profile";
import { localLambdaConfig } from "../../src/aws/local-context";
import { publisher } from "../../src/aws/publication";
import { scheduled } from "../../src/aws/jobs";
import { worker, collector } from "../../src/aws/recovery";
import { contentWorkers } from "../../src/domain/subscriptions";
import { createClients } from "../../src/lab/clients";
import { createLabConfig, localQueueUrl } from "../../src/lab/config";

const config = createLabConfig("runtime-test");
const profile = applicationProfile(config);

describe("actual application AWS composition", () => {
  beforeAll(buildLab, 30_000);
  it("declares every implemented consumer, collector, and job without endpoint overrides", () => {
    expect(profile.workers.map((worker) => worker.consumer)).toEqual(
      contentWorkers.map((worker) => worker.name),
    );
    expect(profile.functions).toHaveLength(9);
    expect(new Set(profile.functions.map((fn) => fn.name)).size).toBe(9);
    for (const fn of applicationProfile(createLabConfig("a".repeat(16))).functions)
      expect(fn.name.length).toBeLessThanOrEqual(64);
    expect(profile.bounds.visibility).toBeGreaterThanOrEqual(profile.bounds.timeout * 6);
    for (const name of [
      ...profile.workers.flatMap((worker) => [worker.queue, worker.dlq]),
      profile.schedulerDlq,
    ])
      expect(localQueueUrl(`http://localstack:4566/000000000000/${name}`, config, name)).toBe(
        `${config.endpoint}/000000000000/${name}`,
      );
    expect(() =>
      localQueueUrl(`${config.endpoint}/000000000000/foreign`, config, "foreign"),
    ).toThrow();
  });
  it("imports every built handler without creating clients or requiring a lab/token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "content-runtime-"));
    try {
      for (const bundle of new Set(profile.functions.map((fn) => fn.bundle))) {
        const archive = unzipSync(
          await readFile(new URL(`../../dist/${bundle}.zip`, import.meta.url)),
        );
        expect(Object.keys(archive)).toEqual(["index.mjs"]);
        const path = join(dir, `${bundle}.mjs`);
        await writeFile(path, archive["index.mjs"]!);
        const names = profile.functions
          .filter((fn) => fn.bundle === bundle)
          .map((fn) => fn.handler.split(".")[1]);
        const result = await promisify(execFile)(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `const handlers = await import(${JSON.stringify(path)}); for (const name of ${JSON.stringify(names)}) { if (typeof handlers[name] !== "function") throw new Error("Missing handler"); }`,
          ],
          { timeout: 10_000, env: { PATH: process.env.PATH, AWS_PROFILE: "must-not-be-loaded" } },
        );
        expect(result.stdout).toBe("");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("local application entrypoint isolation", () => {
  it("requires the exact owned function, stage and consumer before issuing requests", async () => {
    const network = vi.spyOn(NodeHttpHandler.prototype, "handle");
    vi.stubEnv("CONTENT_OPS_LAB_ID", config.instanceId);
    vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "unowned");
    try {
      await expect(publisher({ Records: [] })).rejects.toThrow("local execution context");
      await expect(scheduled({ targetHandler: "duePublication" })).rejects.toThrow(
        "local execution context",
      );
      vi.stubEnv("CONTENT_OPS_CONSUMER", "materializeReview");
      await expect(worker({ Records: [] })).rejects.toThrow("local execution context");
      await expect(collector({ Records: [] })).rejects.toThrow("local execution context");
      vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", "");
      vi.stubEnv("AWS_PROFILE", "private-profile");
      expect(() => createClients(config)).toThrow("AWS_PROFILE");
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      network.mockRestore();
    }
  });
  it("allows only the declared role of each entrypoint, with no AWS-mode escape", () => {
    const env = { CONTENT_OPS_LAB_ID: config.instanceId, AWS_LAMBDA_FUNCTION_NAME: profile.jobs };
    expect(localLambdaConfig("jobs", env).endpoint).toBe("http://localstack:4566");
    expect(
      localLambdaConfig("jobs", {
        ...env,
        LOCALSTACK_HOSTNAME: "172.21.0.2",
        AWS_ENDPOINT_URL: "http://172.21.0.2:4566",
      }).endpoint,
    ).toBe("http://localstack:4566");
    for (const extra of [
      { CONTENT_OPS_RUNTIME: "aws" },
      { CONTENT_OPS_STAGE: "production" },
      { AWS_ENDPOINT_URL_DYNAMODB: "https://dynamodb.us-east-1.amazonaws.com" },
      { LOCALSTACK_HOSTNAME: "172.21.0.2", AWS_ENDPOINT_URL: "http://172.21.0.3:4566" },
      { LOCALSTACK_HOSTNAME: "1.2.3.4", AWS_ENDPOINT_URL: "http://1.2.3.4:4566" },
    ])
      expect(() => localLambdaConfig("jobs", { ...env, ...extra })).toThrow();
  });
});
