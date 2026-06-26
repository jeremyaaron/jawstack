import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
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
