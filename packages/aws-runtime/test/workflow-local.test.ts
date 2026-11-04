import { Readable } from "node:stream";
import {
  DynamoDBClient,
  DescribeTableCommand,
  ListTagsOfResourceCommand,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalAwsTransport,
  createLocalWorkflow,
  parseLocalWorkflowBindings,
  type LocalWorkflowExecution,
  type LocalWorkflowOptions,
} from "@jawstack/aws-runtime/local";
import { copyWorkflowJson, getWorkflowManifest, type WorkflowDefinition } from "@jawstack/core";
import { fixture, auth } from "./support/workflow";
import { WorkflowClient } from "./support/workflow-client";
import {
  lab,
  profile,
  localBindings,
  lambdaExecution,
  tableDescription,
  tableTags,
} from "./support/local";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function cleanEnvironment() {
  for (const key of Object.keys(process.env))
    if (key.startsWith("AWS_")) vi.stubEnv(key, undefined);
}
function contextEnv(context: LocalWorkflowExecution) {
  cleanEnvironment();
  if (context.kind === "lambda") {
    vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME", context.functionName);
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test");
    vi.stubEnv("AWS_ENDPOINT_URL", "http://172.21.0.2:4566");
    vi.stubEnv("LOCALSTACK_HOSTNAME", "172.21.0.2");
  }
}
function harness(executionKind: "host" | "lambda" = "host") {
  const base = fixture("memory");
  const bindings = localBindings(base.definition),
    client = new WorkflowClient(),
    bind = vi.fn(() => ({ process: { handle: () => {} } }));
  const execution: LocalWorkflowExecution =
    executionKind === "host" ? { kind: "host" } : lambdaExecution(bindings);
  contextEnv(execution);
  let description = tableDescription(bindings),
    tags = tableTags(bindings);
  const send = vi.spyOn(DynamoDBClient.prototype, "send").mockImplementation((async (
    command: unknown,
  ) => {
    if (command instanceof DescribeTableCommand) return description;
    if (command instanceof ListTagsOfResourceCommand) return tags;
    return client.send(command as { input: unknown });
  }) as DynamoDBClient["send"]);
  const destroy = vi.spyOn(DynamoDBClient.prototype, "destroy");
  const options: LocalWorkflowOptions = {
    bindings,
    profile: { ...profile },
    lab: { ...lab },
    execution,
    bind,
    authorizeOperations: () => true,
  };
  return {
    ...base,
    bindings,
    options,
    client,
    bind,
    send,
    destroy,
    description: () => description,
    setDescription: (input: typeof description) => {
      description = input;
    },
    tags: () => tags,
    setTags: (input: typeof tags) => {
      tags = input;
    },
  };
}

describe("bounded local routing document", () => {
  it("parses object/string routing data without I/O, freezes deeply and returns a detached copy", async () => {
    const h = harness();
    const input = structuredClone(h.bindings);
    const parsed = parseLocalWorkflowBindings(JSON.stringify(input));
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed.functions[0])).toBe(true);
    expect(h.send).not.toHaveBeenCalled();
    expect(() => {
      (parsed.functions as unknown[]).push({});
    }).toThrow();
    await h.runtime.close();
  });
  it.each([
    "version",
    "endpoint",
    "credentials",
    "tenant",
    "profileHash",
    "account",
    "region",
    "functionDuplicate",
    "missingCollector",
    "queueReuse",
    "queueAccount",
    "namespace",
    "foreignConsumer",
    "jobs",
    "size",
    "undefined",
    "prototype",
  ])("rejects unsafe %s metadata without SDK calls", async (variant) => {
    const h = harness();
    const input = structuredClone(h.bindings) as unknown as Record<string, unknown>;
    if (variant === "version") input.schemaVersion = 2;
    if (variant === "endpoint") input.endpoint = "https://dynamodb.amazonaws.com";
    if (variant === "credentials") input.credentials = { accessKeyId: "secret" };
    if (variant === "tenant") input.tenantId = "foreign";
    if (variant === "profileHash") input.profile = { ...profile, hash: "invalid" };
    if (variant === "account") input.accountId = "123456789012";
    if (variant === "region") input.region = "us-west-2";
    if (variant === "functionDuplicate")
      (input.functions as unknown[]).push((input.functions as unknown[])[0]);
    if (variant === "missingCollector")
      input.functions = h.bindings.functions.filter((f) => f.role !== "collector");
    if (variant === "queueReuse")
      input.consumers = [
        { ...h.bindings.consumers[0], deadLetterQueueArn: h.bindings.consumers[0]!.sourceQueueArn },
      ];
    if (variant === "queueAccount")
      input.consumers = [
        {
          ...h.bindings.consumers[0],
          sourceQueueArn: h.bindings.consumers[0]!.sourceQueueArn.replace(
            "000000000000",
            "123456789012",
          ),
        },
      ];
    if (variant === "namespace") input.tableName = "foreign-table";
    if (variant === "foreignConsumer")
      (input.functions as unknown[]).push({
        name: "jawstack-wf-test-foreign",
        role: "worker",
        consumer: "foreign",
      });
    if (variant === "jobs")
      (input.functions as unknown[]).push({ name: "jawstack-wf-test-jobs", role: "jobs" });
    if (variant === "size") input.extra = "x".repeat(65536);
    if (variant === "undefined") input.extra = undefined;
    if (variant === "prototype") Object.setPrototypeOf(input, { inherited: true });
    expect(() => parseLocalWorkflowBindings(input)).toThrow(/unsafe/);
    expect(h.send).not.toHaveBeenCalled();
    await h.runtime.close();
  });
  it("does not execute getters or leak token/input data in validation errors", async () => {
    const getter = vi.fn(() => "TOKEN-MUST-NOT-LEAK");
    const input = Object.defineProperty({}, "schemaVersion", { get: getter, enumerable: true });
    expect(() => parseLocalWorkflowBindings(input)).toThrow(/unsafe/);
    expect(getter).not.toHaveBeenCalled();
    try {
      parseLocalWorkflowBindings('{"token":"TOKEN-MUST-NOT-LEAK"}');
    } catch (error) {
      expect(String(error)).not.toContain("TOKEN-MUST-NOT-LEAK");
    }
  });
});

describe("guarded local AWS transport", () => {
  it("returns fresh mutable dummy identities for SDK feature annotations without a provider chain", async () => {
    cleanEnvironment();
    const transport = createLocalAwsTransport({ execution: { kind: "host" } });
    const first = await transport.credentials();
    Object.assign(first, { $source: { CREDENTIALS_CODE: "e" }, accessKeyId: "caller-mutated" });
    expect(await transport.credentials()).toEqual({ accessKeyId: "test", secretAccessKey: "test" });
    transport.requestHandler.destroy();
  });
  it.each(["host", "lambda"] as const)(
    "provides fixed dummy credentials/finite timeouts for %s without sending",
    async (kind) => {
      const h = harness(kind);
      const timers = vi.spyOn(globalThis, "setTimeout");
      const transport = createLocalAwsTransport({ execution: h.options.execution });
      expect(transport.endpoint).toBe(
        kind === "host" ? "http://127.0.0.1:4566" : "http://localstack:4566",
      );
      expect(await transport.credentials()).toEqual({
        accessKeyId: "test",
        secretAccessKey: "test",
      });
      expect(transport.maxAttempts).toBe(2);
      expect(h.send).not.toHaveBeenCalled();
      expect(timers).not.toHaveBeenCalled();
      transport.requestHandler.destroy();
      await h.runtime.close();
    },
  );
  it.each([
    "AWS_PROFILE",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_ENDPOINT_URL",
    "AWS_ENDPOINT_URL_DYNAMODB",
    "AWS_REGION",
    "AWS_LAMBDA_FUNCTION_NAME",
    "AWS_USE_HTTP_PROXY",
  ])("blocks inherited host %s before a request", (key) => {
    cleanEnvironment();
    vi.stubEnv(key, "unsafe-secret");
    expect(() => createLocalAwsTransport({ execution: { kind: "host" } })).toThrow(/unsafe/);
  });
  it.each([
    "AWS_PROFILE",
    "AWS_ENDPOINT_URL_DYNAMODB",
    "AWS_REGION",
    "AWS_SESSION_TOKEN",
    "AWS_ROLE_ARN",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_ACCESS_KEY_ID",
  ])("blocks inherited Lambda %s", async (key) => {
    const h = harness("lambda");
    vi.stubEnv(key, "unsafe-secret");
    expect(() => createLocalAwsTransport({ execution: h.options.execution })).toThrow(/unsafe/);
    expect(h.send).not.toHaveBeenCalled();
    await h.runtime.close();
  });
  it("accepts but never uses bounded LocalStack role credentials", async () => {
    const h = harness("lambda");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "LSIAQAAAAAAVNCBMPNSG");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "emulator-only");
    vi.stubEnv("AWS_SESSION_TOKEN", "emulator-session");
    const transport = createLocalAwsTransport({ execution: h.options.execution });
    expect(await transport.credentials()).toEqual({ accessKeyId: "test", secretAccessKey: "test" });
    transport.requestHandler.destroy();
    await h.runtime.close();
  });
  it("accepts explicit emulator metadata without selecting endpoints or credentials from it", async () => {
    const h = harness("lambda");
    vi.stubEnv("AWS_XRAY_DAEMON_ADDRESS", "127.0.0.1:2000");
    vi.stubEnv("AWS_ACCOUNT_ID", "000000000000");
    vi.stubEnv("AWS_LAMBDA_FUNCTION_TIMEOUT", "30");
    vi.stubEnv("AWS_EXECUTION_ENV", "AWS_Lambda_rapid");
    vi.stubEnv("AWS_LAMBDA_RUNTIME_API", "127.0.0.1:9001");
    vi.stubEnv(
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "http://127.0.0.1:9001/2021-04-23/credentials",
    );
    vi.stubEnv("AWS_CONTAINER_AUTHORIZATION_TOKEN", "20000000-0000-4000-8000-000000000001");
    vi.stubEnv("AWS_LAMBDA_METADATA_API", "127.0.0.1:9001");
    vi.stubEnv("AWS_LAMBDA_METADATA_TOKEN", "emulator-only-metadata-token");
    const t = createLocalAwsTransport({ execution: h.options.execution });
    expect(t.endpoint).toBe("http://localstack:4566");
    expect(await t.credentials()).toEqual({ accessKeyId: "test", secretAccessKey: "test" });
    expect(h.send).not.toHaveBeenCalled();
    t.requestHandler.destroy();
    await h.runtime.close();
  });
  it("diagnoses bounded setting names without exposing values or malformed environment keys", async () => {
    const h = harness("lambda");
    vi.stubEnv("AWS_LAMBDA_RUNTIME_API", "private-value");
    expect(() => createLocalAwsTransport({ execution: h.options.execution })).toThrow(
      /unsafe.*AWS_LAMBDA_RUNTIME_API/,
    );
    vi.stubEnv("AWS_LAMBDA_RUNTIME_API", undefined);
    vi.stubEnv("AWS_PRIVATE_VALUE", "private-value");
    expect(() => createLocalAwsTransport({ execution: h.options.execution })).toThrow(
      /unsafe.*AWS_PRIVATE_VALUE/,
    );
    vi.stubEnv("AWS_PRIVATE_VALUE", undefined);
    vi.stubEnv("AWS_bad\nname", "private-value");
    try {
      createLocalAwsTransport({ execution: h.options.execution });
      throw new Error("Expected rejection.");
    } catch (error) {
      expect(String(error)).toContain("unrecognized AWS setting");
      expect(String(error)).not.toMatch(/bad|private-value/);
    }
    expect(h.send).not.toHaveBeenCalled();
    await h.runtime.close();
  });
  it.each([
    ["AWS_XRAY_DAEMON_ADDRESS", "8.8.8.8:2000"],
    ["AWS_XRAY_DAEMON_ADDRESS", "127.0.0.1:443"],
    ["AWS_ACCOUNT_ID", "123456789012"],
    ["AWS_LAMBDA_FUNCTION_TIMEOUT", "29"],
    ["AWS_EXECUTION_ENV", "AWS_Lambda_rapid"],
    ["AWS_CONTAINER_CREDENTIALS_FULL_URI", "http://127.0.0.1:9001/2021-04-23/credentials"],
    ["AWS_CONTAINER_AUTHORIZATION_TOKEN", "20000000-0000-4000-8000-000000000001"],
    ["AWS_LAMBDA_METADATA_API", "127.0.0.1:9001"],
    ["AWS_LAMBDA_METADATA_TOKEN", "emulator-only-metadata-token"],
  ])("rejects unreviewed Lambda metadata %s=%s before transport", async (key, value) => {
    const h = harness("lambda");
    vi.stubEnv(key, value);
    expect(() => createLocalAwsTransport({ execution: h.options.execution })).toThrow(/unsafe/);
    expect(h.send).not.toHaveBeenCalled();
    await h.runtime.close();
  });
  it.each([
    ["AWS_CONTAINER_CREDENTIALS_FULL_URI", "http://169.254.170.2/credentials"],
    ["AWS_CONTAINER_CREDENTIALS_FULL_URI", "http://127.0.0.1:9001/other"],
    ["AWS_CONTAINER_CREDENTIALS_FULL_URI", "http://user@127.0.0.1:9001/2021-04-23/credentials"],
    ["AWS_CONTAINER_AUTHORIZATION_TOKEN", "unbounded-or-unreviewed-token"],
    ["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/credentials"],
    ["AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "/private/token"],
    ["AWS_LAMBDA_RUNTIME_API", "127.0.0.1:9002"],
    ["AWS_LAMBDA_FUNCTION_NAME", "different-function"],
    ["AWS_LAMBDA_METADATA_API", "169.254.100.1:9001"],
    ["AWS_LAMBDA_METADATA_API", "127.0.0.1:9002"],
    ["AWS_LAMBDA_METADATA_TOKEN", "x".repeat(4097)],
    ["AWS_LAMBDA_METADATA_TOKEN", "line\nbreak"],
  ])("rejects credential provider overrides inside emulator metadata: %s", async (key, value) => {
    const h = harness("lambda");
    vi.stubEnv("AWS_LAMBDA_RUNTIME_API", "127.0.0.1:9001");
    vi.stubEnv(
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "http://127.0.0.1:9001/2021-04-23/credentials",
    );
    vi.stubEnv(key, value);
    expect(() => createLocalAwsTransport({ execution: h.options.execution })).toThrow(/unsafe/);
    expect(h.send).not.toHaveBeenCalled();
    await h.runtime.close();
  });
  it.each([
    ["AWS_XRAY_DAEMON_ADDRESS", "127.0.0.1:2000"],
    ["AWS_ACCOUNT_ID", "000000000000"],
    ["AWS_LAMBDA_FUNCTION_TIMEOUT", "30"],
    ["AWS_CONTAINER_CREDENTIALS_FULL_URI", "http://127.0.0.1:9001/2021-04-23/credentials"],
    ["AWS_CONTAINER_AUTHORIZATION_TOKEN", "20000000-0000-4000-8000-000000000001"],
    ["AWS_LAMBDA_METADATA_API", "127.0.0.1:9001"],
    ["AWS_LAMBDA_METADATA_TOKEN", "emulator-only-metadata-token"],
  ])("does not extend host policy for emulator-only %s", (key, value) => {
    cleanEnvironment();
    vi.stubEnv(key, value);
    expect(() => createLocalAwsTransport({ execution: { kind: "host" } })).toThrow(/unsafe/);
  });
  it("reports multiple rejected setting names before any SDK use without their values", async () => {
    const h = harness("lambda");
    vi.stubEnv("AWS_PROFILE", "private-profile");
    vi.stubEnv("AWS_ENDPOINT_URL_DYNAMODB", "https://private-endpoint");
    try {
      createLocalAwsTransport({ execution: h.options.execution });
      throw new Error("Expected rejection.");
    } catch (error) {
      expect(String(error)).toContain("AWS_PROFILE");
      expect(String(error)).toContain("AWS_ENDPOINT_URL_DYNAMODB");
      expect(String(error)).not.toContain("private-");
    }
    expect(h.send).not.toHaveBeenCalled();
    await h.runtime.close();
  });
  it.each(["1.2.3.4", "127.0.0.1", "169.254.169.254", "172.40.0.1", "localstack.attacker"])(
    "rejects injected endpoint metadata at %s",
    async (host) => {
      const h = harness("lambda");
      vi.stubEnv("LOCALSTACK_HOSTNAME", host);
      vi.stubEnv("AWS_ENDPOINT_URL", `http://${host}:4566`);
      expect(() => createLocalAwsTransport({ execution: h.options.execution })).toThrow(/unsafe/);
      await h.runtime.close();
    },
  );
  it.each(["host", "lambda"] as const)(
    "guards the final %s HTTP destination before the native handler",
    async (kind) => {
      const h = harness(kind),
        transport = createLocalAwsTransport({ execution: h.options.execution });
      const send = vi
        .spyOn(NodeHttpHandler.prototype, "handle")
        .mockResolvedValue({ response: { statusCode: 200, headers: {}, body: Readable.from([]) } });
      const hostname = kind === "host" ? "127.0.0.1" : "localstack";
      const request = {
        protocol: "http:",
        hostname,
        port: 4566,
        method: "POST",
        path: "/",
        query: {},
        headers: { host: `${hostname}:4566` },
        clone() {
          return { ...this, headers: { ...this.headers } };
        },
      };
      for (const change of [
        { hostname: "dynamodb.us-east-1.amazonaws.com" },
        { hostname: kind === "host" ? "localstack" : "127.0.0.1" },
        { port: 443 },
        { protocol: "https:" },
        { username: "user" },
        { headers: { host: "attacker:4566" } },
      ]) {
        await expect(async () =>
          transport.requestHandler.handle({ ...request, ...change }),
        ).rejects.toThrow(/unsafe/);
      }
      expect(send).not.toHaveBeenCalled();
      await transport.requestHandler.handle(request);
      expect(send).toHaveBeenCalledTimes(1);
      transport.requestHandler.destroy();
      await h.runtime.close();
    },
  );
  it("does not accept endpoint/client/environment override options", () => {
    cleanEnvironment();
    expect(() =>
      createLocalAwsTransport({ execution: { kind: "host" }, endpoint: "http://evil" } as never),
    ).toThrow(/unsafe/);
    expect(() =>
      createLocalAwsTransport({ execution: { kind: "host", endpoint: "http://evil" } } as never),
    ).toThrow(/unsafe/);
  });
});

describe("local workflow ownership and composition", () => {
  it("keeps client disposal behind the common close guards and performs it once", async () => {
    const h = harness();
    const workflow = await createLocalWorkflow(h.definition, {
      ...h.options,
      validateResult: async () => {
        await expect(async () => workflow.close()).rejects.toMatchObject({
          code: "command.rejected",
        });
        expect(h.destroy).not.toHaveBeenCalled();
      },
    });
    expect(() => workflow.close({ timeoutMs: 0 })).toThrow(/timeout/i);
    expect(h.destroy).not.toHaveBeenCalled();
    expect(await workflow.dispatch(h.request(), auth())).toMatchObject({ ok: true });
    await workflow.close();
    await workflow.close();
    expect(h.destroy).toHaveBeenCalledTimes(1);
    await h.runtime.close();
  });
  it.each(["host", "lambda"] as const)(
    "verifies owned table metadata before binding and uses shared storage for %s",
    async (kind) => {
      const h = harness(kind);
      h.bind.mockImplementation(() => {
        expect(h.send).toHaveBeenCalledTimes(2);
        return { process: { handle: () => {} } };
      });
      const workflow = await createLocalWorkflow(h.definition, h.options);
      expect(h.client.calls).toEqual([]);
      expect(await workflow.dispatch(h.request(), auth())).toMatchObject({ ok: true });
      expect(h.client.calls.some((call) => call instanceof GetItemCommand)).toBe(true);
      expect(h.destroy).not.toHaveBeenCalled();
      await workflow.close();
      expect(h.destroy).toHaveBeenCalledTimes(1);
      await h.runtime.close();
    },
  );
  it.each([
    "workflow",
    "profile",
    "lab",
    "consumer",
    "function",
    "role",
    "invokedArn",
    "option",
    "ids",
    "definition",
    "environment",
  ])("rejects mismatched %s before SDK requests or binding", async (variant) => {
    const h = harness("lambda");
    let options = h.options,
      definition = h.definition;
    if (variant === "workflow")
      options = {
        ...options,
        bindings: { ...h.bindings, workflow: { ...h.bindings.workflow, hash: "c".repeat(64) } },
      };
    if (variant === "profile")
      options = { ...options, profile: { ...profile, hash: "c".repeat(64) } };
    if (variant === "lab") options = { ...options, lab: { ...lab, id: "other" } };
    if (variant === "consumer")
      options = {
        ...options,
        bindings: {
          ...h.bindings,
          consumers: [{ ...h.bindings.consumers[0], consumer: "unregistered" }],
        },
      };
    if (variant === "function")
      options = {
        ...options,
        execution: {
          ...lambdaExecution(h.bindings),
          functionName: "jawstack-wf-test-wrong",
        } as LocalWorkflowExecution,
      };
    if (variant === "role")
      options = {
        ...options,
        execution: { ...lambdaExecution(h.bindings), role: "collector" } as LocalWorkflowExecution,
      };
    if (variant === "invokedArn")
      options = {
        ...options,
        execution: {
          ...lambdaExecution(h.bindings),
          invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:wrong",
        } as LocalWorkflowExecution,
      };
    if (variant === "option") options = { ...options, client: {} } as LocalWorkflowOptions;
    if (variant === "ids") options = { ...options, ids: { eventId: "not-a-function" } } as never;
    if (variant === "definition")
      definition = { manifest: h.definition.manifest } as WorkflowDefinition;
    if (variant === "environment") vi.stubEnv("AWS_PROFILE", "real-cloud");
    await expect(createLocalWorkflow(definition, options)).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.bind).not.toHaveBeenCalled();
    await h.runtime.close();
  });
  it.each([
    "arn",
    "status",
    "key",
    "type",
    "owner",
    "workflow",
    "profile",
    "lab",
    "duplicateTag",
    "pagination",
  ])("rejects table %s before business binding and destroys the owned client", async (variant) => {
    const h = harness();
    const table = structuredClone(h.description());
    if (variant === "arn")
      table.Table.TableArn = table.Table.TableArn.replace("000000000000", "123456789012");
    if (variant === "status") table.Table.TableStatus = "CREATING";
    if (variant === "key") table.Table.KeySchema[0]!.AttributeName = "wrong";
    if (variant === "type") table.Table.AttributeDefinitions[0]!.AttributeType = "N";
    h.setDescription(table);
    const tags = structuredClone(h.tags());
    if (["owner", "workflow", "profile", "lab"].includes(variant))
      tags.Tags.find((tag) => tag.Key === `jawstack:${variant}`)!.Value = "foreign";
    if (variant === "duplicateTag") tags.Tags.push(tags.Tags[0]!);
    h.setTags(
      variant === "pagination"
        ? ({ ...tags, NextToken: "unknown-more-tags" } as typeof tags)
        : tags,
    );
    await expect(createLocalWorkflow(h.definition, h.options)).rejects.toThrow(/unsafe/);
    expect(h.bind).not.toHaveBeenCalled();
    expect(h.client.calls).toEqual([]);
    expect(h.destroy).toHaveBeenCalledTimes(1);
    await h.runtime.close();
  });
  it("captures bindings/profile/identity before the ownership await", async () => {
    const h = harness(),
      options = {
        ...h.options,
        profile: { ...profile },
        lab: { ...lab },
        bindings: structuredClone(h.bindings),
      };
    const pending = createLocalWorkflow(h.definition, options);
    options.profile.hash = "c".repeat(64);
    options.lab.ownerId = "foreign";
    (options.bindings as { tableName: string }).tableName = "foreign";
    const workflow = await pending;
    expect(workflow.manifest.hash).toBe(h.definition.manifest.hash);
    await workflow.close();
    await h.runtime.close();
  });
  it("redacts ownership SDK errors and destroys clients on failure", async () => {
    const h = harness();
    h.send.mockRejectedValue(new Error("TOKEN-private-provider-diagnostics"));
    await expect(createLocalWorkflow(h.definition, h.options)).rejects.toThrow(
      "Local workflow ownership verification failed.",
    );
    expect(h.bind).not.toHaveBeenCalled();
    expect(h.destroy).toHaveBeenCalledTimes(1);
    await h.runtime.close();
  });
  it("exposes owned manifest and JSON validation without changing declarations or running callbacks", async () => {
    const h = harness();
    expect(getWorkflowManifest(h.definition)).toBe(h.definition.manifest);
    expect(() =>
      getWorkflowManifest({ manifest: h.definition.manifest } as WorkflowDefinition),
    ).toThrow(/owned/);
    expect(() => copyWorkflowJson({ value: Infinity })).toThrow(/finite/);
    expect(() => copyWorkflowJson({ value: "long" }, 1)).toThrow(/budget/);
    expect(h.send).not.toHaveBeenCalled();
    await h.runtime.close();
  });
});
