import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { App, Duration, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as s3 from "aws-cdk-lib/aws-s3";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  defineSchedule,
  defineWorker,
  workRequestResource,
  type ResourceDefinition,
} from "@jawstack/core";

import {
  describePackage,
  JawStackResourceWorkflowApp,
  packageName,
  type JawStackResourceWorkflowAppProps,
  type JawStackWorkerBinding,
} from "../src/index";

describe("@jawstack/aws-cdk", () => {
  it("exports package metadata", () => {
    expect(packageName).toBe("@jawstack/aws-cdk");
    expect(describePackage()).toContain("CDK");
  });

  it("synthesizes the resource workflow backend", () => {
    const template = synthTemplate();

    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.resourceCountIs("AWS::Events::EventBus", 1);
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
    template.resourceCountIs("AWS::Lambda::Function", 5);
    template.resourceCountIs("AWS::Logs::LogGroup", 5);
    template.resourceCountIs("AWS::Lambda::EventSourceMapping", 2);
    template.resourceCountIs("AWS::Events::Rule", 2);
    template.resourceCountIs("AWS::SQS::Queue", 3);
    template.resourceCountIs("AWS::Scheduler::Schedule", 1);
  });

  it("preserves baseline logical IDs and resource types", () => {
    const template = synthTemplate().toJSON();
    const resources = template.Resources as Record<string, { Type: string }>;
    expect(
      Object.fromEntries(Object.entries(resources).map(([id, resource]) => [id, resource.Type])),
    ).toMatchSnapshot();
  });

  it("configures the DynamoDB table with stream, TTL, and outbox GSI", () => {
    const template = synthTemplate();

    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        {
          AttributeName: "PK",
          KeyType: "HASH",
        },
        {
          AttributeName: "SK",
          KeyType: "RANGE",
        },
      ],
      StreamSpecification: {
        StreamViewType: "NEW_AND_OLD_IMAGES",
      },
      TimeToLiveSpecification: {
        AttributeName: "expiresAt",
        Enabled: true,
      },
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: "GSI1",
          KeySchema: [
            {
              AttributeName: "GSI1PK",
              KeyType: "HASH",
            },
            {
              AttributeName: "GSI1SK",
              KeyType: "RANGE",
            },
          ],
          Projection: {
            ProjectionType: "ALL",
          },
        }),
      ],
    });
  });

  it("configures Lambdas with explicit timeout, memory, concurrency, and log retention", () => {
    const template = synthTemplate();

    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "jawstack-test-dev-api",
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      Timeout: 12,
      MemorySize: 384,
      ReservedConcurrentExecutions: 7,
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "jawstack-test-dev-outbox-dispatcher",
      Runtime: "nodejs22.x",
      Handler: "index.dispatcher",
      Timeout: 30,
      MemorySize: 384,
      ReservedConcurrentExecutions: 7,
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "jawstack-test-dev-outbox-sweeper",
      Runtime: "nodejs22.x",
      Handler: "index.sweeper",
      Timeout: 30,
      MemorySize: 384,
      ReservedConcurrentExecutions: 1,
    });
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/aws/lambda/jawstack-test-dev-api",
      RetentionInDays: 7,
    });
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/aws/lambda/jawstack-test-dev-outbox-dispatcher",
      RetentionInDays: 7,
    });
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/aws/lambda/jawstack-test-dev-outbox-sweeper",
      RetentionInDays: 7,
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "jawstack-test-dev-sendnotification-worker",
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      Timeout: 12,
      MemorySize: 384,
      ReservedConcurrentExecutions: 2,
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "jawstack-test-dev-staleworkrequestreminder-scheduler",
      Runtime: "nodejs22.x",
      Handler: "index.handler",
      Timeout: 12,
      MemorySize: 384,
      ReservedConcurrentExecutions: 7,
      Environment: {
        Variables: Match.objectLike({
          JAWSTACK_SCHEDULE_NAME: "staleWorkRequestReminder",
          JAWSTACK_SCHEDULE_TARGET_HANDLER: "staleWorkRequestReminder",
        }),
      },
    });
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/aws/lambda/jawstack-test-dev-sendnotification-worker",
      RetentionInDays: 7,
    });
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/aws/lambda/jawstack-test-dev-staleworkrequestreminder-scheduler",
      RetentionInDays: 7,
    });
  });

  it("wires HTTP API Gateway to the API Lambda", () => {
    const template = synthTemplate();

    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      Name: "jawstack-test-dev-api",
      ProtocolType: "HTTP",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "ANY /{proxy+}",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Integration", {
      IntegrationType: "AWS_PROXY",
      PayloadFormatVersion: "2.0",
    });
    expect(Object.values(template.toJSON().Outputs ?? {})).toContainEqual({
      Value: {
        "Fn::GetAtt": [expect.stringMatching(/^WorkflowApiHttpApi/), "ApiEndpoint"],
      },
    });
  });

  it("grants API Lambda table access", () => {
    const template = synthTemplate();

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "dynamodb:BatchGetItem",
              "dynamodb:Query",
              "dynamodb:GetItem",
              "dynamodb:Scan",
              "dynamodb:ConditionCheckItem",
              "dynamodb:BatchWriteItem",
              "dynamodb:PutItem",
              "dynamodb:UpdateItem",
              "dynamodb:DeleteItem",
            ]),
            Effect: "Allow",
          }),
        ]),
      },
      Roles: Match.arrayWith([
        {
          Ref: Match.stringLikeRegexp("ApiFunctionServiceRole"),
        },
      ]),
    });
  });

  it("grants outbox Lambdas table and EventBridge permissions", () => {
    const template = synthTemplate();

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["dynamodb:Query", "dynamodb:UpdateItem"]),
            Effect: "Allow",
          }),
          Match.objectLike({
            Action: "events:PutEvents",
            Effect: "Allow",
          }),
        ]),
      },
      Roles: Match.arrayWith([
        {
          Ref: Match.stringLikeRegexp("OutboxDispatcherFunctionServiceRole"),
        },
      ]),
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["dynamodb:Query", "dynamodb:UpdateItem"]),
            Effect: "Allow",
          }),
          Match.objectLike({
            Action: "events:PutEvents",
            Effect: "Allow",
          }),
        ]),
      },
      Roles: Match.arrayWith([
        {
          Ref: Match.stringLikeRegexp("OutboxSweeperFunctionServiceRole"),
        },
      ]),
    });
  });

  it("wires the outbox stream dispatcher and sweeper schedule", () => {
    const template = synthTemplate();

    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 10,
      StartingPosition: "LATEST",
      MaximumRetryAttempts: 3,
    });
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(5 minutes)",
      State: "ENABLED",
    });
  });

  it("creates worker queue, DLQ, Lambda, and max-concurrency event source mapping", () => {
    const template = synthTemplate();

    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "jawstack-test-dev-sendnotification-dlq",
      MessageRetentionPeriod: 1209600,
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "jawstack-test-dev-sendnotification-queue",
      VisibilityTimeout: 72,
      MessageRetentionPeriod: 345600,
      RedrivePolicy: {
        maxReceiveCount: 4,
      },
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 10,
      ScalingConfig: {
        MaximumConcurrency: 2,
      },
    });
  });

  it("routes configured EventBridge event types to the worker queue", () => {
    const template = synthTemplate();

    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: {
        "detail-type": ["workRequest.created"],
      },
      State: "ENABLED",
      Targets: Match.arrayWith([
        Match.objectLike({
          Arn: {
            "Fn::GetAtt": [Match.stringLikeRegexp("sendNotificationQueue"), "Arn"],
          },
        }),
      ]),
    });
  });

  it("creates scheduler target Lambda, daily schedule, retry policy, and DLQ", () => {
    const template = synthTemplate();

    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "jawstack-test-dev-staleworkrequestreminder-scheduler-dlq",
      MessageRetentionPeriod: 1209600,
    });
    template.hasResourceProperties("AWS::Scheduler::Schedule", {
      Name: "jawstack-test-dev-staleworkrequestreminder-schedule",
      ScheduleExpression: "rate(1 day)",
      FlexibleTimeWindow: {
        Mode: "OFF",
      },
      State: "ENABLED",
      Target: Match.objectLike({
        Arn: {
          "Fn::GetAtt": [Match.stringLikeRegexp("staleWorkRequestReminderFunction"), "Arn"],
        },
        RetryPolicy: {
          MaximumRetryAttempts: 3,
          MaximumEventAgeInSeconds: 7200,
        },
        DeadLetterConfig: {
          Arn: {
            "Fn::GetAtt": [Match.stringLikeRegexp("staleWorkRequestReminderDlq"), "Arn"],
          },
        },
        Input: JSON.stringify({
          scheduleName: "staleWorkRequestReminder",
          targetHandler: "staleWorkRequestReminder",
        }),
      }),
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "lambda:InvokeFunction",
            Effect: "Allow",
          }),
          Match.objectLike({
            Action: "sqs:SendMessage",
            Effect: "Allow",
          }),
        ]),
      },
      Roles: Match.arrayWith([
        {
          Ref: Match.stringLikeRegexp("staleWorkRequestReminderInvocationRole"),
        },
      ]),
    });
  });

  it("grants worker Lambda table access", () => {
    const template = synthTemplate();

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["dynamodb:GetItem", "dynamodb:PutItem"]),
            Effect: "Allow",
          }),
        ]),
      },
      Roles: Match.arrayWith([
        {
          Ref: Match.stringLikeRegexp("sendNotificationFunctionServiceRole"),
        },
      ]),
    });
  });

  it("grants scheduler Lambda table read access", () => {
    const template = synthTemplate();

    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["dynamodb:Query", "dynamodb:GetItem"]),
            Effect: "Allow",
          }),
        ]),
      },
      Roles: Match.arrayWith([
        {
          Ref: Match.stringLikeRegexp("staleWorkRequestReminderFunctionServiceRole"),
        },
      ]),
    });
  });

  it("exposes declared names with the original array instances, order, queue wiring, and readonly wrappers", () => {
    const { stack, workflow } = createWorkflow(namedProps());
    expect(Object.keys(workflow.workerBindingsByName)).toEqual(["publishContent", "verifyAsset"]);
    expect(Object.keys(workflow.schedulerFunctionsByName)).toEqual(["firstTick", "secondTick"]);
    const template = Template.fromStack(stack);
    for (const [index, name] of ["publishContent", "verifyAsset"].entries()) {
      const binding: JawStackWorkerBinding = workflow.workerBindingsByName[name]!;
      expect(binding.workerFunction).toBe(workflow.workerFunctions[index]);
      expect(binding.queue).toBe(workflow.workerQueues[index]);
      expect(Object.isFrozen(binding)).toBe(true);
      template.hasResourceProperties("AWS::SQS::Queue", {
        RedrivePolicy: {
          deadLetterTargetArn: stack.resolve(binding.deadLetterQueue.queueArn),
          maxReceiveCount: 4,
        },
      });
      template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
        EventSourceArn: stack.resolve(binding.queue.queueArn),
        FunctionName: stack.resolve(binding.workerFunction.functionName),
      });
    }
    for (const [index, name] of ["firstTick", "secondTick"].entries()) {
      const fn = workflow.schedulerFunctionsByName[name]!;
      expect(fn).toBe(workflow.schedulerFunctions[index]);
      template.hasResourceProperties("AWS::Lambda::Function", {
        Environment: {
          Variables: Match.objectLike({
            JAWSTACK_SCHEDULE_NAME: name,
            JAWSTACK_SCHEDULE_TARGET_HANDLER: "sharedTick",
          }),
        },
      });
    }
    expect(workflow.schedulerFunctionsByName.firstTick).not.toBe(
      workflow.schedulerFunctionsByName.secondTick,
    );
    expect(workflow.schedulerFunctionsByName.sharedTick).toBeUndefined();
    expect(Object.isFrozen(workflow.workerBindingsByName)).toBe(true);
    expect(Object.isFrozen(workflow.schedulerFunctionsByName)).toBe(true);
  });

  it("returns empty records/arrays and undefined for unknown names without prototype fallback", () => {
    expectTypeOf<JawStackResourceWorkflowApp["workerBindingsByName"][string]>().toEqualTypeOf<
      JawStackWorkerBinding | undefined
    >();
    expectTypeOf<JawStackResourceWorkflowApp["schedulerFunctionsByName"][string]>().toEqualTypeOf<
      lambda.Function | undefined
    >();
    const props = workflowProps();
    const { workflow } = createWorkflow({
      ...props,
      resources: [{ ...workerResource(), workers: [], schedules: [] }],
      entrypoints: {
        apiHandler: props.entrypoints.apiHandler,
        outboxHandler: props.entrypoints.outboxHandler,
      },
    });
    expect(Object.keys(workflow.workerBindingsByName)).toEqual([]);
    expect(Object.keys(workflow.schedulerFunctionsByName)).toEqual([]);
    expect(workflow.workerFunctions).toEqual([]);
    expect(workflow.workerQueues).toEqual([]);
    expect(workflow.schedulerFunctions).toEqual([]);
    expect(workflow.schedulerDlqs).toEqual([]);
    expect(Object.getPrototypeOf(workflow.workerBindingsByName)).toBeNull();
    expect(Object.getPrototypeOf(workflow.schedulerFunctionsByName)).toBeNull();
    for (const name of ["missing", "constructor", "toString", "__proto__"]) {
      expect(workflow.workerBindingsByName[name]).toBeUndefined();
      expect(workflow.schedulerFunctionsByName[name]).toBeUndefined();
    }
  });

  it("keeps worker/schedule namespaces independent and supports own prototype-like handler names", () => {
    const props = workflowProps();
    const { workflow } = createWorkflow({
      ...props,
      resources: [
        {
          ...workerResource(),
          workers: [defineWorker({ name: "constructor", eventTypes: ["workRequest.created"] })],
          schedules: [
            defineSchedule({
              name: "constructor",
              expression: "rate(1 day)",
              targetHandler: "toString",
            }),
          ],
        },
      ],
      entrypoints: {
        ...props.entrypoints,
        workerHandlers: { constructor: props.entrypoints.apiHandler },
        schedulerHandlers: { toString: props.entrypoints.apiHandler },
      },
    });
    const name: string = "constructor";
    expect(workflow.workerBindingsByName[name]!.workerFunction).toBe(workflow.workerFunctions[0]);
    expect(workflow.schedulerFunctionsByName[name]).toBe(workflow.schedulerFunctions[0]);
  });

  it.each(["worker", "schedule"] as const)(
    "rejects duplicate %s names within one resource before creating infrastructure",
    (kind) => {
      const resource = workerResource();
      const duplicated =
        kind === "worker"
          ? { ...resource, workers: [...resource.workers, ...resource.workers] }
          : { ...resource, schedules: [...resource.schedules, ...resource.schedules] };
      expectInvalidWorkflow(
        { ...workflowProps(), resources: [duplicated] },
        `Duplicate ${kind} name`,
      );
    },
  );

  it.each(["worker", "schedule"] as const)(
    "rejects duplicate %s names across resources before creating infrastructure",
    (kind) => {
      const resource = workerResource();
      const first =
        kind === "worker" ? { ...resource, schedules: [] } : { ...resource, workers: [] };
      expectInvalidWorkflow(
        { ...workflowProps(), resources: [first, { ...first, name: "reviewTask" }] },
        `Duplicate ${kind} name`,
      );
    },
  );

  it.each(["worker", "scheduler"] as const)(
    "rejects missing/blank %s handler entrypoints before creating infrastructure",
    (kind) => {
      for (const value of [undefined, "", "   "]) {
        const props = workflowProps();
        const name = kind === "worker" ? "sendNotification" : "staleWorkRequestReminder";
        const handlers = value === undefined ? {} : { [name]: value };
        expectInvalidWorkflow(
          {
            ...props,
            entrypoints: {
              ...props.entrypoints,
              ...(kind === "worker"
                ? { workerHandlers: handlers }
                : { schedulerHandlers: handlers }),
            },
          },
          `Missing ${kind} handler entrypoint for "${name}".`,
        );
      }
    },
  );

  it.each(["worker", "scheduler"] as const)(
    "does not adopt inherited %s handler entrypoints",
    (kind) => {
      const props = workflowProps();
      const name = kind === "worker" ? "sendNotification" : "staleWorkRequestReminder";
      const handlers: Record<string, string> = Object.create({
        [name]: props.entrypoints.apiHandler,
      });
      expectInvalidWorkflow(
        {
          ...props,
          entrypoints: {
            ...props.entrypoints,
            ...(kind === "worker" ? { workerHandlers: handlers } : { schedulerHandlers: handlers }),
          },
        },
        `Missing ${kind} handler entrypoint for "${name}".`,
      );
    },
  );

  it("grants object access to only the named worker without inspecting construct children", () => {
    const { stack, workflow } = createWorkflow(namedProps());
    const bucket = new s3.Bucket(stack, "Artifacts", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });
    const publisher = workflow.workerBindingsByName.publishContent!;
    bucket.grantReadWrite(publisher.workerFunction, "publications/*");
    const template = Template.fromStack(stack);
    const put = statementsForFunction(template, stack, publisher.workerFunction).find((statement) =>
      actions(statement).includes("s3:PutObject"),
    );
    expect(put).toBeDefined();
    expect(resources(put!)).toContainEqual(stack.resolve(bucket.arnForObjects("publications/*")));
    expect(resources(put!)).not.toContainEqual(stack.resolve(bucket.arnForObjects("*")));
    for (const fn of [
      workflow.apiFunction,
      workflow.workerBindingsByName.verifyAsset!.workerFunction,
      ...workflow.schedulerFunctions,
    ])
      expect(statementsForFunction(template, stack, fn).flatMap(actions)).not.toContain(
        "s3:PutObject",
      );
  });

  it("grants writes only to the selected schedule, retaining other schedulers' read-only default", () => {
    const { stack, workflow } = createWorkflow(namedProps());
    const tick = workflow.schedulerFunctionsByName.firstTick!;
    workflow.table.grantWriteData(tick);
    const template = Template.fromStack(stack);
    const put = statementsForFunction(template, stack, tick).find((statement) =>
      actions(statement).includes("dynamodb:PutItem"),
    );
    expect(put).toBeDefined();
    expect(resources(put!)).toContainEqual(stack.resolve(workflow.table.tableArn));
    expect(
      statementsForFunction(template, stack, workflow.schedulerFunctionsByName.secondTick!).flatMap(
        actions,
      ),
    ).not.toContain("dynamodb:PutItem");
    expect(
      statementsForFunction(template, stack, workflow.schedulerFunctionsByName.secondTick!).flatMap(
        actions,
      ),
    ).toContain("dynamodb:Query");
  });

  it("attaches an application-owned collector to the named DLQ using only public bindings", () => {
    const { stack, workflow } = createWorkflow();
    const binding = workflow.workerBindingsByName.sendNotification!;
    const collector = new lambda.Function(stack, "FailureCollector", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambda.Code.fromInline("exports.handler = async () => {};"),
      timeout: Duration.seconds(5),
      reservedConcurrentExecutions: 2,
    });
    workflow.table.grantReadWriteData(collector);
    collector.addEventSource(
      new SqsEventSource(binding.deadLetterQueue, { batchSize: 1, maxConcurrency: 2 }),
    );
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::Lambda::Function", 6);
    template.resourceCountIs("AWS::Lambda::EventSourceMapping", 3);
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      EventSourceArn: stack.resolve(binding.deadLetterQueue.queueArn),
      FunctionName: stack.resolve(collector.functionName),
      BatchSize: 1,
      ScalingConfig: { MaximumConcurrency: 2 },
    });
    const statements = statementsForFunction(template, stack, collector);
    const consume = statements.find((statement) =>
      actions(statement).includes("sqs:DeleteMessage"),
    );
    expect(consume).toBeDefined();
    expect(resources(consume!)).toContainEqual(stack.resolve(binding.deadLetterQueue.queueArn));
    expect(statements.flatMap(actions)).toContain("dynamodb:PutItem");
    expect(statements.flatMap(actions)).toContain("dynamodb:GetItem");
    expect(
      statementsForFunction(template, stack, binding.workerFunction).flatMap((statement) =>
        actions(statement).includes("sqs:DeleteMessage") ? resources(statement) : [],
      ),
    ).not.toContainEqual(stack.resolve(binding.deadLetterQueue.queueArn));
  });
});

function createWorkflow(props = workflowProps()) {
  const stack = new Stack(new App(), "NamedStack");
  return { stack, workflow: new JawStackResourceWorkflowApp(stack, "Workflow", props) };
}

function expectInvalidWorkflow(props: JawStackResourceWorkflowAppProps, message: string) {
  const stack = new Stack(new App(), "InvalidStack");
  expect(() => new JawStackResourceWorkflowApp(stack, "Workflow", props)).toThrow(message);
  const template = Template.fromStack(stack);
  template.resourceCountIs("AWS::DynamoDB::Table", 0);
  template.resourceCountIs("AWS::Lambda::Function", 0);
  template.resourceCountIs("AWS::SQS::Queue", 0);
}

type PolicyStatement = Readonly<{ Action: string | readonly string[]; Resource: unknown }>;
function actions(statement: PolicyStatement): readonly string[] {
  return typeof statement.Action === "string" ? [statement.Action] : statement.Action;
}
function resources(statement: PolicyStatement): readonly unknown[] {
  return Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
}
function statementsForFunction(
  template: Template,
  stack: Stack,
  fn: lambda.Function,
): readonly PolicyStatement[] {
  const role = stack.resolve(fn.role!.roleName);
  const policies = Object.values(template.findResources("AWS::IAM::Policy")) as {
    Properties: { Roles: unknown[]; PolicyDocument: { Statement: PolicyStatement[] } };
  }[];
  return policies
    .filter((policy) =>
      policy.Properties.Roles.some((candidate) => isDeepStrictEqual(candidate, role)),
    )
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
}

function namedProps(): JawStackResourceWorkflowAppProps {
  const props = workflowProps();
  const entrypoint = props.entrypoints.apiHandler;
  return {
    ...props,
    resources: [
      {
        ...workerResource(),
        workers: [defineWorker({ name: "publishContent", eventTypes: ["workRequest.created"] })],
        schedules: [
          defineSchedule({
            name: "firstTick",
            expression: "rate(1 day)",
            targetHandler: "sharedTick",
          }),
        ],
      },
      {
        ...workerResource(),
        name: "reviewTask",
        workers: [defineWorker({ name: "verifyAsset", eventTypes: ["workRequest.closed"] })],
        schedules: [
          defineSchedule({
            name: "secondTick",
            expression: "rate(1 hour)",
            targetHandler: "sharedTick",
          }),
        ],
      },
    ],
    entrypoints: {
      ...props.entrypoints,
      workerHandlers: { publishContent: entrypoint, verifyAsset: entrypoint },
      schedulerHandlers: { sharedTick: entrypoint },
    },
  };
}

describe("consumer worker transport options", () => {
  it("supports bounded single-message batches, collector visibility, and a source filter", () => {
    const app = new App();
    const stack = new Stack(app, "ConsumerOptions");
    new JawStackResourceWorkflowApp(stack, "Workflow", {
      ...workflowProps(),
      workerOptions: {
        batchSize: 1,
        deadLetterVisibilityTimeoutSeconds: 180,
        eventSource: "content-operations.dev",
      },
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: 1,
      EventSourceArn: Match.objectLike({
        "Fn::GetAtt": Match.arrayWith([Match.stringLikeRegexp(".*sendNotificationQueue.*"), "Arn"]),
      }),
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "jawstack-test-dev-sendnotification-dlq",
      VisibilityTimeout: 180,
    });
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: { "detail-type": ["workRequest.created"], source: ["content-operations.dev"] },
    });
  });
  it.each([
    { batchSize: 0 },
    { batchSize: 11 },
    { batchSize: 1.5 },
    { deadLetterVisibilityTimeoutSeconds: 30 },
    { deadLetterVisibilityTimeoutSeconds: 43201 },
    { eventSource: " " },
    { eventSource: "bad\nsource" },
  ])("rejects unsafe worker options before creating service resources: %j", (workerOptions) => {
    const app = new App();
    const stack = new Stack(app, "InvalidOptions");
    expect(
      () =>
        new JawStackResourceWorkflowApp(stack, "Workflow", { ...workflowProps(), workerOptions }),
    ).toThrow();
    expect(Template.fromStack(stack).toJSON().Resources ?? {}).toEqual({});
  });
});

function synthTemplate(): Template {
  const app = new App();
  const stack = new Stack(app, "TestStack");

  new JawStackResourceWorkflowApp(stack, "Workflow", workflowProps());

  return Template.fromStack(stack);
}

function workflowProps(): JawStackResourceWorkflowAppProps {
  const entrypointDir = createEntrypointDir();

  return {
    appName: "jawstack-test",
    stage: "dev",
    resources: [workerResource()],
    costProfile: {
      lambda: {
        defaultTimeoutSeconds: 12,
        maxTimeoutSeconds: 30,
        defaultMemoryMb: 384,
        reservedConcurrency: 7,
      },
      dynamodb: {
        billingMode: "onDemand",
        pointInTimeRecovery: false,
      },
      queues: {
        defaultMaxConcurrency: 5,
        maxReceiveCount: 4,
        requireDlq: true,
      },
      scheduler: {
        maxRetryAttempts: 3,
        maxEventAgeSeconds: 7200,
        requireDlq: true,
      },
    },
    auth: {
      mode: "external",
      provider: "header",
    },
    entrypoints: {
      apiHandler: entrypointDir,
      outboxHandler: entrypointDir,
      workerHandlers: {
        sendNotification: entrypointDir,
      },
      schedulerHandlers: {
        staleWorkRequestReminder: entrypointDir,
      },
    },
  };
}

function workerResource(): ResourceDefinition {
  return {
    ...workRequestResource,
    workers: [
      defineWorker({
        name: "sendNotification",
        eventTypes: ["workRequest.created"],
        maxConcurrency: 2,
      }),
    ],
    schedules: [
      defineSchedule({
        name: "staleWorkRequestReminder",
        expression: "rate(1 day)",
        targetHandler: "staleWorkRequestReminder",
      }),
    ],
  };
}

function createEntrypointDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "jawstack-cdk-test-"));
  writeFileSync(
    join(directory, "index.js"),
    [
      "export async function handler() { return { statusCode: 200, body: '{}'}; }",
      "export async function dispatcher() {}",
      "export async function sweeper() {}",
    ].join("\n"),
  );
  return directory;
}
