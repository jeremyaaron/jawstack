import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { WorkflowDefinition } from "@jawstack/core";
import { JawStackResourceWorkflowApp, type JawStackResourceWorkflowAppProps } from "../src/index";
import { asset, definition, legacyProps, managedProps, resource } from "./support/recovery";

type Resource = { Type: string; Properties: Record<string, unknown>; DeletionPolicy?: string };
type Statement = { Action: string | string[]; Resource: unknown | unknown[]; Effect: string };
const actions = (statement: Statement) => [statement.Action].flat();
const resources = (statement: Statement) => [statement.Resource].flat();
function synth(props = managedProps(), stackName = "RecoveryTest") {
  const stack = new Stack(new App({ autoSynth: false }), stackName, {
    env: { account: "000000000000", region: "us-east-1" },
  });
  const workflow = new JawStackResourceWorkflowApp(stack, "Workflow", props);
  const template = () => Template.fromStack(stack);
  const policy = (fn: lambda.Function) => {
    const role = stack.resolve(fn.role!.roleName);
    const policies = Object.values(template().findResources("AWS::IAM::Policy")) as {
      Properties: { Roles: unknown[]; PolicyDocument: { Statement: Statement[] } };
    }[];
    return policies
      .filter((p) => p.Properties.Roles.some((r) => isDeepStrictEqual(r, role)))
      .flatMap((p) => p.Properties.PolicyDocument.Statement);
  };
  const byType = (type: string) =>
    Object.entries(template().toJSON().Resources as Record<string, Resource>).filter(
      ([, resource]) => resource.Type === type,
    );
  return { stack, workflow, template, policy, byType };
}
function invalid(props: JawStackResourceWorkflowAppProps) {
  const stack = new Stack(new App({ autoSynth: false }), "InvalidRecovery");
  expect(() => new JawStackResourceWorkflowApp(stack, "Workflow", props)).toThrow();
  expect(Template.fromStack(stack).toJSON().Resources ?? {}).toEqual({});
}
describe("opt-in recoverable infrastructure", () => {
  it("preserves the complete pre-change no-opt-in template, not just resource counts/IDs", () => {
    const h = synth(legacyProps(), "RecoveryBaseline");
    const baseline = JSON.parse(
      readFileSync(new URL("./fixtures/no-recovery-template.json", import.meta.url), "utf8"),
    );
    expect(h.template().toJSON()).toEqual(baseline);
    expect(Object.keys(h.workflow.collectorFunctionsByName)).toEqual([]);
    expect(Object.isFrozen(h.workflow.collectorFunctionsByName)).toBe(true);
    expect(h.workflow.collectorFunctionsByName.toString).toBeUndefined();
    expect(h.workflow.collectorFunctionsByName.__proto__).toBeUndefined();
  });
  it("creates one explicitly logged collector per existing worker DLQ, without new stores or queue chains", () => {
    const h = synth(managedProps([resource("workRequest", ["second", "first"])]));
    const template = h.template();
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.resourceCountIs("AWS::Events::EventBus", 1);
    template.resourceCountIs("AWS::SQS::Queue", 5);
    template.resourceCountIs("AWS::Lambda::Function", 8);
    template.resourceCountIs("AWS::Logs::LogGroup", 8);
    template.resourceCountIs("AWS::Lambda::EventSourceMapping", 5);
    template.resourceCountIs("AWS::Events::Rule", 3);
    expect(Object.keys(h.workflow.collectorFunctionsByName)).toEqual(["first", "second"]);
    expect(Object.isFrozen(h.workflow.collectorFunctionsByName)).toBe(true);
    expectTypeOf<JawStackResourceWorkflowApp["collectorFunctionsByName"][string]>().toEqualTypeOf<
      lambda.Function | undefined
    >();
    for (const name of ["first", "second"]) {
      const binding = h.workflow.workerBindingsByName[name]!,
        collector = h.workflow.collectorFunctionsByName[name]!;
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: `recovery-test-dev-${name}-collector`,
        Handler: "index.handler",
        Runtime: "nodejs22.x",
        Architectures: ["arm64"],
        Timeout: 30,
        MemorySize: 256,
        ReservedConcurrentExecutions: 2,
      });
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: `/aws/lambda/recovery-test-dev-${name}-collector`,
        RetentionInDays: 7,
      });
      template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
        EventSourceArn: h.stack.resolve(binding.deadLetterQueue.queueArn),
        FunctionName: h.stack.resolve(collector.functionName),
        BatchSize: 1,
        ScalingConfig: { MaximumConcurrency: 2 },
      });
      template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
        EventSourceArn: h.stack.resolve(binding.queue.queueArn),
        FunctionName: h.stack.resolve(binding.workerFunction.functionName),
        BatchSize: 1,
        ScalingConfig: { MaximumConcurrency: 2 },
      });
      template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: `recovery-test-dev-${name}-queue`,
        VisibilityTimeout: 180,
        MessageRetentionPeriod: 345600,
        RedrivePolicy: {
          maxReceiveCount: 3,
          deadLetterTargetArn: h.stack.resolve(binding.deadLetterQueue.queueArn),
        },
      });
      template.hasResourceProperties("AWS::SQS::Queue", {
        QueueName: `recovery-test-dev-${name}-dlq`,
        VisibilityTimeout: 180,
        MessageRetentionPeriod: 1209600,
      });
      expect(collector.node.id).toBe(`${name}Collector`);
      expect(collector.logGroup.node.id).toBe(`${name}CollectorLogs`);
    }
    expect(
      h
        .byType("AWS::Lambda::Function")
        .filter(([, r]) => String(r.Properties.FunctionName).endsWith("-collector"))
        .every(([, r]) => r.Properties.DeadLetterConfig === undefined),
    ).toBe(true);
    expect(
      h
        .byType("AWS::SQS::Queue")
        .filter(([, r]) => String(r.Properties.QueueName).endsWith("-dlq"))
        .every(([, r]) => r.Properties.RedrivePolicy === undefined),
    ).toBe(true);
  });
  it("binds source/consumer identity by name and filters events from the manifest source", () => {
    const h = synth();
    for (const [fn, role] of [
      [h.workflow.workerBindingsByName.process!.workerFunction, "worker"],
      [h.workflow.collectorFunctionsByName.process!, "collector"],
    ] as const) {
      const target = h
        .byType("AWS::Lambda::Function")
        .find(([id]) => isDeepStrictEqual(h.stack.resolve(fn.functionName), { Ref: id }))![1];
      expect(target.Properties.Environment).toMatchObject({
        Variables: {
          JAWSTACK_WORKER_NAME: "process",
          JAWSTACK_WORKFLOW_ROLE: role,
          JAWSTACK_WORKFLOW_NAME: "recovery-test",
          JAWSTACK_WORKFLOW_HASH: managedProps().recoverableWorkers!.definition.manifest.hash,
          JAWSTACK_EVENT_SOURCE: "recovery-test.local",
          JAWSTACK_SOURCE_QUEUE_ARN: h.stack.resolve(
            h.workflow.workerBindingsByName.process!.queue.queueArn,
          ),
          JAWSTACK_DEAD_LETTER_QUEUE_ARN: h.stack.resolve(
            h.workflow.workerBindingsByName.process!.deadLetterQueue.queueArn,
          ),
        },
      });
    }
    h.template().hasResourceProperties("AWS::Events::Rule", {
      EventPattern: { source: ["recovery-test.local"], "detail-type": ["workRequest.created"] },
    });
    expect(JSON.stringify(h.byType("AWS::Lambda::Function"))).not.toMatch(
      /AUTH_TOKEN|AWS_PROFILE|ACCESS_KEY|ENDPOINT_URL/,
    );
  });
  it("scopes collector grants to its table, own DLQ and own logs without unrelated AWS services", () => {
    const h = synth(managedProps([resource("workRequest", ["first", "second"])]));
    for (const name of ["first", "second"]) {
      const collector = h.workflow.collectorFunctionsByName[name]!,
        statements = h.policy(collector);
      const role = h.stack.resolve(collector.role!.roleName) as { Ref: string };
      expect(
        h.template().findResources("AWS::IAM::Role")[role.Ref]!.Properties.ManagedPolicyArns,
      ).toBeUndefined();
      const logActions = statements.filter((s) => actions(s).some((a) => a.startsWith("logs:")));
      expect(logActions.flatMap(actions)).toEqual(
        expect.arrayContaining(["logs:CreateLogStream", "logs:PutLogEvents"]),
      );
      for (const statement of logActions)
        expect(JSON.stringify(resources(statement))).toContain(
          h.stack.getLogicalId(
            collector.logGroup.node.defaultChild as import("aws-cdk-lib").CfnElement,
          ),
        );
      const tableActions = statements.filter((s) =>
        actions(s).some((a) => a.startsWith("dynamodb:")),
      );
      expect(tableActions.flatMap(actions).sort()).toEqual(
        [
          "dynamodb:DeleteItem",
          "dynamodb:DescribeTable",
          "dynamodb:GetItem",
          "dynamodb:ListTagsOfResource",
          "dynamodb:PutItem",
          "dynamodb:Query",
        ].sort(),
      );
      for (const statement of tableActions)
        expect(resources(statement)).toEqual([h.stack.resolve(h.workflow.table.tableArn)]);
      const queueActions = statements.filter((s) => actions(s).some((a) => a.startsWith("sqs:")));
      expect(queueActions.flatMap(actions).sort()).toEqual(
        [
          "sqs:ChangeMessageVisibility",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl",
          "sqs:ReceiveMessage",
        ].sort(),
      );
      for (const statement of queueActions)
        expect(resources(statement)).toEqual([
          h.stack.resolve(h.workflow.workerBindingsByName[name]!.deadLetterQueue.queueArn),
        ]);
      for (const statement of statements) {
        expect(resources(statement)).not.toContain("*");
        expect(actions(statement).every((a) => /^(dynamodb|sqs|logs):/.test(a))).toBe(true);
      }
      const workerQueues = h
        .policy(h.workflow.workerBindingsByName[name]!.workerFunction)
        .filter((s) => actions(s).includes("sqs:ReceiveMessage"))
        .flatMap(resources);
      expect(workerQueues).toEqual([
        h.stack.resolve(h.workflow.workerBindingsByName[name]!.queue.queueArn),
      ]);
    }
  });
  it("grants exact metadata reads to every workflow role only on opt-in and stamps workflow identity", () => {
    const h = synth();
    for (const fn of [
      h.workflow.apiFunction,
      h.workflow.outboxDispatcherFunction,
      h.workflow.outboxSweeperFunction,
      ...h.workflow.workerFunctions,
      ...h.workflow.schedulerFunctions,
      h.workflow.collectorFunctionsByName.process!,
    ]) {
      const tags = h.policy(fn).find((s) => actions(s).includes("dynamodb:ListTagsOfResource"));
      expect(tags).toBeDefined();
      expect(actions(tags!)).toContain("dynamodb:DescribeTable");
      expect(resources(tags!)).toEqual([h.stack.resolve(h.workflow.table.tableArn)]);
      const target = h
        .byType("AWS::Lambda::Function")
        .find(([id]) => isDeepStrictEqual(h.stack.resolve(fn.functionName), { Ref: id }))![1];
      expect(target.Properties.Environment).toMatchObject({
        Variables: {
          JAWSTACK_EVENT_SOURCE: "recovery-test.local",
          JAWSTACK_WORKFLOW_NAME: "recovery-test",
        },
      });
    }
    const table = h.byType("AWS::DynamoDB::Table")[0]![1];
    expect(table.Properties.Tags).toContainEqual({
      Key: "jawstack:workflow",
      Value: managedProps().recoverableWorkers!.definition.manifest.hash,
    });
    expect(JSON.stringify(synth(legacyProps()).template().toJSON())).not.toContain(
      "dynamodb:ListTagsOfResource",
    );
  });
  it("allows application-specific grants through stable bindings without leaking them to other consumers", () => {
    const h = synth(managedProps([resource("workRequest", ["first", "second"])]));
    const bucket = new s3.Bucket(h.stack, "Artifacts");
    bucket.grantWrite(h.workflow.workerBindingsByName.first!.workerFunction, "publications/*");
    bucket.grantRead(h.workflow.collectorFunctionsByName.first!, "reconciliation/*");
    expect(
      JSON.stringify(h.policy(h.workflow.workerBindingsByName.first!.workerFunction)),
    ).toContain("publications/*");
    expect(JSON.stringify(h.policy(h.workflow.collectorFunctionsByName.first!))).toContain(
      "reconciliation/*",
    );
    for (const fn of [
      h.workflow.collectorFunctionsByName.second!,
      h.workflow.workerBindingsByName.second!.workerFunction,
      ...h.workflow.schedulerFunctions,
      h.workflow.apiFunction,
    ])
      expect(
        h
          .policy(fn)
          .flatMap(actions)
          .some((a) => a.startsWith("s3:")),
      ).toBe(false);
  });
  it("accepts explicit matching worker options and retains requested removal policy", () => {
    const props = managedProps();
    const h = synth({
      ...props,
      removalPolicy: "retain",
      workerOptions: {
        batchSize: 1,
        deadLetterVisibilityTimeoutSeconds: 180,
        eventSource: props.recoverableWorkers!.definition.manifest.source,
      },
    });
    expect(
      h
        .byType("AWS::Logs::LogGroup")
        .find(([, r]) => String(r.Properties.LogGroupName).endsWith("-collector"))![1]
        .DeletionPolicy,
    ).toBe("Retain");
  });
  it.each([
    "resource",
    "command",
    "roles",
    "emissions",
    "subscription",
    "workerConcurrency",
    "missingConsumer",
    "extraHandler",
    "source",
    "batch",
    "visibility",
    "timeout",
    "memory",
    "reserved",
    "receives",
    "queueConcurrency",
    "typedCost",
    "policyTimeout",
    "policyVisibility",
    "policyBatch",
    "policyConcurrency",
    "definition",
    "assetMissing",
    "assetBlank",
    "assetType",
    "option",
    "collision",
    "nameLength",
    "consumerLimit",
  ])("rejects %s mismatch before service resources", (variant) => {
    let props = managedProps();
    const base = props.resources[0]!;
    if (variant === "resource") props = { ...props, resources: [{ ...base, name: "different" }] };
    if (variant === "command")
      props = {
        ...props,
        resources: [
          {
            ...base,
            commands: Object.fromEntries(
              Object.entries(base.commands).filter(([name]) => name !== "create"),
            ),
          },
        ],
      };
    if (variant === "roles")
      props = {
        ...props,
        resources: [
          {
            ...base,
            commands: {
              ...base.commands,
              create: { ...base.commands.create!, roles: ["different"] },
            },
          },
        ],
      };
    if (variant === "emissions")
      props = {
        ...props,
        resources: [
          {
            ...base,
            commands: { ...base.commands, create: { ...base.commands.create!, emits: [] } },
          },
        ],
      };
    if (variant === "subscription")
      props = {
        ...props,
        resources: [
          { ...base, workers: [{ ...base.workers[0]!, eventTypes: ["workRequest.closed"] }] },
        ],
      };
    if (variant === "workerConcurrency")
      props = {
        ...props,
        resources: [{ ...base, workers: [{ ...base.workers[0]!, maxConcurrency: 3 }] }],
      };
    if (variant === "missingConsumer")
      props = {
        ...props,
        resources: [{ ...base, workers: [] }],
        entrypoints: { ...props.entrypoints, workerHandlers: {} },
      };
    if (variant === "extraHandler")
      props = {
        ...props,
        entrypoints: {
          ...props.entrypoints,
          workerHandlers: { ...props.entrypoints.workerHandlers, other: asset },
        },
      };
    if (variant === "source") props = { ...props, workerOptions: { eventSource: "foreign" } };
    if (variant === "batch") props = { ...props, workerOptions: { batchSize: 10 } };
    if (variant === "visibility")
      props = { ...props, workerOptions: { deadLetterVisibilityTimeoutSeconds: 181 } };
    if (["timeout", "memory", "reserved"].includes(variant))
      props = {
        ...props,
        costProfile: {
          ...props.costProfile,
          lambda: {
            defaultTimeoutSeconds: variant === "timeout" ? 15 : 30,
            maxTimeoutSeconds: 30,
            defaultMemoryMb: variant === "memory" ? 512 : 256,
            reservedConcurrency: variant === "reserved" ? 3 : 2,
          },
        },
      };
    if (["receives", "queueConcurrency", "typedCost"].includes(variant))
      props = {
        ...props,
        costProfile: {
          ...props.costProfile,
          queues: {
            defaultMaxConcurrency:
              variant === "queueConcurrency" ? 3 : variant === "typedCost" ? "two" : 2,
            maxReceiveCount: variant === "receives" ? 5 : 3,
          },
        },
      };
    if (["policyTimeout", "policyVisibility", "policyBatch"].includes(variant))
      props = {
        ...props,
        recoverableWorkers: {
          definition: definition(props.resources, {
            process: {
              recovery: "replay",
              ...(variant === "policyTimeout"
                ? { timeoutSeconds: 15 }
                : variant === "policyVisibility"
                  ? { visibilityTimeoutSeconds: 181 }
                  : { batchSize: 2 }),
            },
          }),
          collectorHandler: asset,
        },
      };
    if (variant === "policyConcurrency")
      props = managedProps([{ ...base, workers: [{ ...base.workers[0]!, maxConcurrency: 3 }] }]);
    if (variant === "definition")
      props = {
        ...props,
        recoverableWorkers: {
          definition: {
            manifest: props.recoverableWorkers!.definition.manifest,
          } as WorkflowDefinition,
          collectorHandler: asset,
        },
      };
    if (variant === "assetMissing")
      props = {
        ...props,
        recoverableWorkers: {
          ...props.recoverableWorkers!,
          collectorHandler: `${asset}missing.zip`,
        },
      };
    if (variant === "assetBlank")
      props = {
        ...props,
        recoverableWorkers: { ...props.recoverableWorkers!, collectorHandler: " " },
      };
    if (variant === "assetType")
      props = {
        ...props,
        recoverableWorkers: { ...props.recoverableWorkers!, collectorHandler: `${asset}index.js` },
      };
    if (variant === "option")
      props = {
        ...props,
        recoverableWorkers: { ...props.recoverableWorkers!, subscriptions: [] } as never,
      };
    if (variant === "collision")
      props = managedProps([resource("workRequest", ["sameName", "samename"])]);
    if (variant === "nameLength") props = { ...props, appName: "x".repeat(60) };
    if (variant === "consumerLimit")
      props = managedProps([
        resource(
          "workRequest",
          Array.from({ length: 41 }, (_, i) => `worker${i}`),
        ),
      ]);
    invalid(props);
  });
  it("rejects recovery option getters without executing them", () => {
    const props = managedProps();
    let reads = 0;
    invalid({
      ...props,
      recoverableWorkers: Object.defineProperty({}, "definition", {
        enumerable: true,
        get: () => {
          reads++;
          return props.recoverableWorkers!.definition;
        },
      }) as never,
    });
    expect(reads).toBe(0);
  });
});
