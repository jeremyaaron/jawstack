import { describe, expect, it, vi } from "vitest";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import { createClients, destroyClients, LocalOnlyHttpHandler } from "../../src/lab/clients";
import {
  assertCleanAwsEnvironment,
  assertOwned,
  createLabConfig,
  hostEndpoint,
  localQueueUrl,
  manifestSchema,
  localstackImage,
  selectRuntime,
  validateEndpoint,
  validateRequest,
} from "../../src/lab/config";

describe("local lab isolation", () => {
  it("requires explicit runtimes and validates identifiers", () => {
    expect(selectRuntime("memory")).toBe("memory");
    expect(selectRuntime("localstack")).toBe("localstack");
    for (const value of [undefined, "aws", "", "production"])
      expect(() => selectRuntime(value)).toThrow();
    for (const id of ["../dev", "Upper", "a;command", "a".repeat(17), ""])
      expect(() => createLabConfig(id)).toThrow();
  });

  it.each([
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_ENDPOINT_URL",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_ROLE_ARN",
  ])("rejects inherited %s without leaking values", (key) => {
    expect(() => assertCleanAwsEnvironment({ [key]: "secret-value" })).toThrow(key);
    try {
      assertCleanAwsEnvironment({ [key]: "secret-value" });
    } catch (error) {
      expect(String(error)).not.toContain("secret-value");
    }
  });

  it("permits only explicit safe AWS environment settings", () => {
    expect(() =>
      assertCleanAwsEnvironment({ AWS_REGION: "us-east-1", AWS_EC2_METADATA_DISABLED: "true" }),
    ).not.toThrow();
    expect(() => assertCleanAwsEnvironment({ AWS_REGION: "eu-west-1" })).toThrow();
  });

  it.each([
    "https://dynamodb.us-east-1.amazonaws.com",
    "http://127.0.0.1.evil:4566",
    "http://localhost:4566",
    "http://127.0.0.1:80",
    "http://user:secret@127.0.0.1:4566",
    "http://127.0.0.1:4566/path",
    "http://127.0.0.1:4566?redirect=aws",
    "http://127.0.0.1:4566#fragment",
  ])("rejects unsafe endpoint %s", (url) => {
    expect(() => validateEndpoint(url)).toThrow();
  });

  it("guards every final transport request before network access", async () => {
    const network = vi.spyOn(NodeHttpHandler.prototype, "handle").mockImplementation(() => {
      throw new Error("NETWORK SHOULD NOT BE CALLED");
    });
    const handler = new LocalOnlyHttpHandler(hostEndpoint);
    for (const hostname of ["dynamodb.us-east-1.amazonaws.com", "169.254.169.254", "localstack"]) {
      expect(() =>
        handler.handle({ protocol: "http:", hostname, port: 4566 } as Parameters<
          NodeHttpHandler["handle"]
        >[0]),
      ).toThrow("Blocked");
    }
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
    handler.destroy();
  });

  it("sets explicit dummy credentials, endpoint, and finite retries on SDK clients", async () => {
    const c = createClients(createLabConfig());
    for (const client of Object.values(c)) {
      expect(await client.config.credentials()).toMatchObject({
        accessKeyId: "test",
        secretAccessKey: "test",
      });
      expect(await client.config.region()).toBe("us-east-1");
      expect(await client.config.maxAttempts()).toBe(2);
    }
    let attempts = 0;
    c.dynamo.middlewareStack.add(
      (next) => async (args) => {
        const request = args.request as { hostname: string };
        request.hostname = "dynamodb.us-east-1.amazonaws.com";
        attempts++;
        return next(args);
      },
      { step: "finalizeRequest", name: "unsafeEndpointTest", priority: "low" },
    );
    await expect(
      c.dynamo.send(new GetItemCommand({ TableName: "proof", Key: { PK: { S: "x" } } })),
    ).rejects.toThrow("Blocked");
    expect(attempts).toBe(1);
    destroyClients(c);
  });

  it("normalizes only declared local queue origins and the owned queue", () => {
    const config = createLabConfig();
    expect(localQueueUrl(`http://localstack:4566/000000000000/${config.queue}`, config)).toBe(
      `${hostEndpoint}/000000000000/${config.queue}`,
    );
    for (const url of [
      `https://sqs.us-east-1.amazonaws.com/000000000000/${config.queue}`,
      `${hostEndpoint}/000000000000/foreign`,
      `${hostEndpoint}/000000000000/${config.queue}?url=aws`,
    ])
      expect(() => localQueueUrl(url, config)).toThrow();
    expect(() =>
      validateRequest({ protocol: "http:", hostname: "127.0.0.1", port: 443 }, hostEndpoint),
    ).toThrow();
  });

  it("requires exact ownership and a strictly versioned manifest", () => {
    expect(() => assertOwned({ "jawstack:owner": "foreign" }, "owned")).toThrow();
    expect(() => assertOwned(undefined, "owned")).toThrow();
    expect(() => assertOwned({ "jawstack:owner": "owned" }, "owned")).not.toThrow();
    expect(
      manifestSchema.safeParse({
        schemaVersion: 1,
        instanceId: "dev",
        ownerId: "not-a-uuid",
        image: localstackImage,
        status: "ready",
        architecture: "arm64",
      }).success,
    ).toBe(false);
  });
});
