import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Duration, RemovalPolicy } from "aws-cdk-lib";
import type {
  CostProfile,
  ManifestAuth,
  ResourceDefinition,
  ScheduleDefinition,
  WorkerDefinition,
} from "@jawstack/core";
import { Construct } from "constructs";

export const packageName = "@jawstack/aws-cdk";

export function describePackage(): string {
  return `${packageName} CDK constructs`;
}

export type JawStackRemovalPolicy = "destroy" | "retain";

export type JawStackResourceWorkflowEntrypoints = Readonly<{
  apiHandler: string;
  outboxHandler: string;
  workerHandlers?: Readonly<Record<string, string>>;
  schedulerHandlers?: Readonly<Record<string, string>>;
  frontendDist?: string;
}>;

export type JawStackResourceWorkflowAppProps = Readonly<{
  appName: string;
  stage: string;
  resources: readonly ResourceDefinition[];
  costProfile: CostProfile;
  auth: ManifestAuth;
  entrypoints: JawStackResourceWorkflowEntrypoints;
  removalPolicy?: JawStackRemovalPolicy;
}>;

export class JawStackResourceWorkflowApp extends Construct {
  readonly table: dynamodb.Table;
  readonly eventBus: events.EventBus;
  readonly httpApi: apigatewayv2.HttpApi;
  readonly apiFunction: lambda.Function;
  readonly outboxDispatcherFunction: lambda.Function;
  readonly outboxSweeperFunction: lambda.Function;
  readonly workerFunctions: readonly lambda.Function[];
  readonly workerQueues: readonly sqs.Queue[];
  readonly schedulerFunctions: readonly lambda.Function[];
  readonly schedulerDlqs: readonly sqs.Queue[];

  constructor(scope: Construct, id: string, props: JawStackResourceWorkflowAppProps) {
    super(scope, id);

    const names = resourceNames(props.appName, props.stage);
    const removalPolicy = removalPolicyFor(props.stage, props.removalPolicy);
    const lambdaDefaults = lambdaDefaultsFromCostProfile(props.costProfile);
    const queueDefaults = queueDefaultsFromCostProfile(props.costProfile);
    const schedulerDefaults = schedulerDefaultsFromCostProfile(props.costProfile);

    const tableConstruct = new JawStackTableConstruct(this, "Table", {
      tableName: names.tableName,
      removalPolicy,
      pointInTimeRecovery: pointInTimeRecoveryFromCostProfile(props.costProfile),
    });
    const eventBusConstruct = new JawStackEventBusConstruct(this, "EventBus", {
      eventBusName: names.eventBusName,
    });
    const apiConstruct = new JawStackApiConstruct(this, "Api", {
      appName: props.appName,
      stage: props.stage,
      apiName: names.httpApiName,
      functionName: names.apiFunctionName,
      codePath: props.entrypoints.apiHandler,
      table: tableConstruct.table,
      eventBus: eventBusConstruct.eventBus,
      lambdaDefaults,
      removalPolicy,
      auth: props.auth,
    });
    const outboxConstruct = new JawStackOutboxConstruct(this, "Outbox", {
      appName: props.appName,
      stage: props.stage,
      dispatcherFunctionName: names.outboxDispatcherFunctionName,
      sweeperFunctionName: names.outboxSweeperFunctionName,
      codePath: props.entrypoints.outboxHandler,
      table: tableConstruct.table,
      eventBus: eventBusConstruct.eventBus,
      lambdaDefaults,
      removalPolicy,
    });
    const workerConstruct = new JawStackWorkerConstruct(this, "Workers", {
      appName: props.appName,
      stage: props.stage,
      workers: workersFromResources(props.resources),
      workerHandlers: props.entrypoints.workerHandlers ?? {},
      table: tableConstruct.table,
      eventBus: eventBusConstruct.eventBus,
      lambdaDefaults,
      queueDefaults,
      removalPolicy,
    });
    const schedulerConstruct = new JawStackSchedulerConstruct(this, "Schedulers", {
      appName: props.appName,
      stage: props.stage,
      schedules: schedulesFromResources(props.resources),
      schedulerHandlers: props.entrypoints.schedulerHandlers ?? {},
      table: tableConstruct.table,
      lambdaDefaults,
      schedulerDefaults,
      removalPolicy,
    });

    this.table = tableConstruct.table;
    this.eventBus = eventBusConstruct.eventBus;
    this.httpApi = apiConstruct.httpApi;
    this.apiFunction = apiConstruct.apiFunction;
    this.outboxDispatcherFunction = outboxConstruct.dispatcherFunction;
    this.outboxSweeperFunction = outboxConstruct.sweeperFunction;
    this.workerFunctions = workerConstruct.workerFunctions;
    this.workerQueues = workerConstruct.workerQueues;
    this.schedulerFunctions = schedulerConstruct.schedulerFunctions;
    this.schedulerDlqs = schedulerConstruct.schedulerDlqs;
  }
}

type LambdaDefaults = Readonly<{
  timeout: Duration;
  outboxTimeout: Duration;
  memorySize: number;
  reservedConcurrency: number;
  sweeperReservedConcurrency: number;
  logRetention: logs.RetentionDays;
}>;

type QueueDefaults = Readonly<{
  maxReceiveCount: number;
  defaultMaxConcurrency: number;
}>;

type SchedulerDefaults = Readonly<{
  maxRetryAttempts: number;
  maxEventAgeSeconds: number;
}>;

type JawStackTableConstructProps = Readonly<{
  tableName: string;
  removalPolicy: RemovalPolicy;
  pointInTimeRecovery: boolean;
}>;

class JawStackTableConstruct extends Construct {
  readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: JawStackTableConstructProps) {
    super(scope, id);

    this.table = new dynamodb.Table(this, "ResourceTable", {
      tableName: props.tableName,
      partitionKey: {
        name: "PK",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "SK",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: "expiresAt",
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: props.pointInTimeRecovery,
      },
      removalPolicy: props.removalPolicy,
    });

    this.table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: {
        name: "GSI1PK",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: "GSI1SK",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }
}

type JawStackEventBusConstructProps = Readonly<{
  eventBusName: string;
}>;

class JawStackEventBusConstruct extends Construct {
  readonly eventBus: events.EventBus;

  constructor(scope: Construct, id: string, props: JawStackEventBusConstructProps) {
    super(scope, id);

    this.eventBus = new events.EventBus(this, "EventBus", {
      eventBusName: props.eventBusName,
    });
  }
}

type JawStackApiConstructProps = Readonly<{
  appName: string;
  stage: string;
  apiName: string;
  functionName: string;
  codePath: string;
  table: dynamodb.Table;
  eventBus: events.EventBus;
  lambdaDefaults: LambdaDefaults;
  removalPolicy: RemovalPolicy;
  auth: ManifestAuth;
}>;

class JawStackApiConstruct extends Construct {
  readonly apiFunction: lambda.Function;
  readonly httpApi: apigatewayv2.HttpApi;

  constructor(scope: Construct, id: string, props: JawStackApiConstructProps) {
    super(scope, id);

    createLogGroup(
      this,
      "ApiLogGroup",
      props.functionName,
      props.lambdaDefaults,
      props.removalPolicy,
    );

    this.apiFunction = new lambda.Function(this, "ApiFunction", {
      functionName: props.functionName,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(props.codePath),
      timeout: props.lambdaDefaults.timeout,
      memorySize: props.lambdaDefaults.memorySize,
      reservedConcurrentExecutions: props.lambdaDefaults.reservedConcurrency,
      environment: {
        JAWSTACK_APP_NAME: props.appName,
        JAWSTACK_STAGE: props.stage,
        JAWSTACK_TABLE_NAME: props.table.tableName,
        JAWSTACK_EVENT_BUS_NAME: props.eventBus.eventBusName,
        JAWSTACK_AUTH_MODE: props.auth.mode,
        JAWSTACK_AUTH_PROVIDER: props.auth.provider,
      },
    });

    props.table.grantReadWriteData(this.apiFunction);

    this.httpApi = new apigatewayv2.HttpApi(this, "HttpApi", {
      apiName: props.apiName,
    });

    this.httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [apigatewayv2.HttpMethod.ANY],
      integration: new integrations.HttpLambdaIntegration("ApiIntegration", this.apiFunction),
    });
  }
}

type JawStackOutboxConstructProps = Readonly<{
  appName: string;
  stage: string;
  dispatcherFunctionName: string;
  sweeperFunctionName: string;
  codePath: string;
  table: dynamodb.Table;
  eventBus: events.EventBus;
  lambdaDefaults: LambdaDefaults;
  removalPolicy: RemovalPolicy;
}>;

class JawStackOutboxConstruct extends Construct {
  readonly dispatcherFunction: lambda.Function;
  readonly sweeperFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: JawStackOutboxConstructProps) {
    super(scope, id);

    createLogGroup(
      this,
      "OutboxDispatcherLogGroup",
      props.dispatcherFunctionName,
      props.lambdaDefaults,
      props.removalPolicy,
    );
    createLogGroup(
      this,
      "OutboxSweeperLogGroup",
      props.sweeperFunctionName,
      props.lambdaDefaults,
      props.removalPolicy,
    );

    this.dispatcherFunction = new lambda.Function(this, "OutboxDispatcherFunction", {
      functionName: props.dispatcherFunctionName,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.dispatcher",
      code: lambda.Code.fromAsset(props.codePath),
      timeout: props.lambdaDefaults.outboxTimeout,
      memorySize: props.lambdaDefaults.memorySize,
      reservedConcurrentExecutions: props.lambdaDefaults.reservedConcurrency,
      environment: outboxEnvironment(props),
    });

    this.sweeperFunction = new lambda.Function(this, "OutboxSweeperFunction", {
      functionName: props.sweeperFunctionName,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.sweeper",
      code: lambda.Code.fromAsset(props.codePath),
      timeout: props.lambdaDefaults.outboxTimeout,
      memorySize: props.lambdaDefaults.memorySize,
      reservedConcurrentExecutions: props.lambdaDefaults.sweeperReservedConcurrency,
      environment: outboxEnvironment(props),
    });

    props.table.grantStreamRead(this.dispatcherFunction);
    props.table.grantReadWriteData(this.dispatcherFunction);
    props.table.grantReadWriteData(this.sweeperFunction);
    props.eventBus.grantPutEventsTo(this.dispatcherFunction);
    props.eventBus.grantPutEventsTo(this.sweeperFunction);

    new lambda.EventSourceMapping(this, "OutboxStreamMapping", {
      target: this.dispatcherFunction,
      eventSourceArn: requireTableStreamArn(props.table),
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 10,
      retryAttempts: 3,
    });

    new events.Rule(this, "OutboxSweeperSchedule", {
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(this.sweeperFunction, { retryAttempts: 2 })],
    });
  }
}

type JawStackWorkerConstructProps = Readonly<{
  appName: string;
  stage: string;
  workers: readonly WorkerDefinition[];
  workerHandlers: Readonly<Record<string, string>>;
  table: dynamodb.Table;
  eventBus: events.EventBus;
  lambdaDefaults: LambdaDefaults;
  queueDefaults: QueueDefaults;
  removalPolicy: RemovalPolicy;
}>;

class JawStackWorkerConstruct extends Construct {
  readonly workerFunctions: readonly lambda.Function[];
  readonly workerQueues: readonly sqs.Queue[];

  constructor(scope: Construct, id: string, props: JawStackWorkerConstructProps) {
    super(scope, id);

    const workerFunctions: lambda.Function[] = [];
    const workerQueues: sqs.Queue[] = [];

    props.workers.forEach((worker) => {
      const codePath = props.workerHandlers[worker.name];

      if (codePath === undefined) {
        throw new Error(`Missing worker handler entrypoint for "${worker.name}".`);
      }

      const maxConcurrency = worker.maxConcurrency ?? props.queueDefaults.defaultMaxConcurrency;
      const workerName = `${safeName(props.appName)}-${safeName(props.stage)}-${safeName(worker.name)}`;
      const functionName = `${workerName}-worker`;
      const timeout = props.lambdaDefaults.timeout;
      const visibilityTimeout = Duration.seconds(timeout.toSeconds() * 6);

      createLogGroup(
        this,
        `${worker.name}LogGroup`,
        functionName,
        props.lambdaDefaults,
        props.removalPolicy,
      );

      const dlq = new sqs.Queue(this, `${worker.name}Dlq`, {
        queueName: `${workerName}-dlq`,
        retentionPeriod: Duration.days(14),
        removalPolicy: props.removalPolicy,
      });
      const queue = new sqs.Queue(this, `${worker.name}Queue`, {
        queueName: `${workerName}-queue`,
        visibilityTimeout,
        retentionPeriod: Duration.days(4),
        deadLetterQueue: {
          queue: dlq,
          maxReceiveCount: props.queueDefaults.maxReceiveCount,
        },
        removalPolicy: props.removalPolicy,
      });
      const workerFunction = new lambda.Function(this, `${worker.name}Function`, {
        functionName,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: "index.handler",
        code: lambda.Code.fromAsset(codePath),
        timeout,
        memorySize: props.lambdaDefaults.memorySize,
        reservedConcurrentExecutions: maxConcurrency,
        environment: {
          JAWSTACK_APP_NAME: props.appName,
          JAWSTACK_STAGE: props.stage,
          JAWSTACK_TABLE_NAME: props.table.tableName,
          JAWSTACK_EVENT_BUS_NAME: props.eventBus.eventBusName,
          JAWSTACK_WORKER_NAME: worker.name,
        },
      });

      props.table.grantReadWriteData(workerFunction);
      workerFunction.addEventSource(
        new lambdaEventSources.SqsEventSource(queue, {
          batchSize: 10,
          maxConcurrency,
        }),
      );

      new events.Rule(this, `${worker.name}EventRule`, {
        eventBus: props.eventBus,
        eventPattern: {
          detailType: [...worker.eventTypes],
        },
        targets: [new targets.SqsQueue(queue)],
      });

      workerFunctions.push(workerFunction);
      workerQueues.push(queue);
    });

    this.workerFunctions = workerFunctions;
    this.workerQueues = workerQueues;
  }
}

type JawStackSchedulerConstructProps = Readonly<{
  appName: string;
  stage: string;
  schedules: readonly ScheduleDefinition[];
  schedulerHandlers: Readonly<Record<string, string>>;
  table: dynamodb.Table;
  lambdaDefaults: LambdaDefaults;
  schedulerDefaults: SchedulerDefaults;
  removalPolicy: RemovalPolicy;
}>;

class JawStackSchedulerConstruct extends Construct {
  readonly schedulerFunctions: readonly lambda.Function[];
  readonly schedulerDlqs: readonly sqs.Queue[];

  constructor(scope: Construct, id: string, props: JawStackSchedulerConstructProps) {
    super(scope, id);

    const schedulerFunctions: lambda.Function[] = [];
    const schedulerDlqs: sqs.Queue[] = [];

    props.schedules.forEach((scheduleDefinition) => {
      const handlerName = scheduleDefinition.targetHandler ?? scheduleDefinition.name;
      const codePath = props.schedulerHandlers[handlerName];

      if (codePath === undefined) {
        throw new Error(`Missing scheduler handler entrypoint for "${handlerName}".`);
      }

      const scheduleBaseName = `${safeName(props.appName)}-${safeName(props.stage)}-${safeName(
        scheduleDefinition.name,
      )}`;
      const functionName = `${scheduleBaseName}-scheduler`;

      createLogGroup(
        this,
        `${scheduleDefinition.name}LogGroup`,
        functionName,
        props.lambdaDefaults,
        props.removalPolicy,
      );

      const schedulerFunction = new lambda.Function(this, `${scheduleDefinition.name}Function`, {
        functionName,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: "index.handler",
        code: lambda.Code.fromAsset(codePath),
        timeout: props.lambdaDefaults.timeout,
        memorySize: props.lambdaDefaults.memorySize,
        reservedConcurrentExecutions: props.lambdaDefaults.reservedConcurrency,
        environment: {
          JAWSTACK_APP_NAME: props.appName,
          JAWSTACK_STAGE: props.stage,
          JAWSTACK_TABLE_NAME: props.table.tableName,
          JAWSTACK_SCHEDULE_NAME: scheduleDefinition.name,
          JAWSTACK_SCHEDULE_TARGET_HANDLER: handlerName,
        },
      });
      const dlq = new sqs.Queue(this, `${scheduleDefinition.name}Dlq`, {
        queueName: `${scheduleBaseName}-scheduler-dlq`,
        retentionPeriod: Duration.days(14),
        removalPolicy: props.removalPolicy,
      });
      const invocationRole = new iam.Role(this, `${scheduleDefinition.name}InvocationRole`, {
        assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      });
      const retry = scheduleDefinition.retry ?? {
        maxAttempts: props.schedulerDefaults.maxRetryAttempts,
        maxEventAgeSeconds: props.schedulerDefaults.maxEventAgeSeconds,
      };

      props.table.grantReadData(schedulerFunction);
      invocationRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["lambda:InvokeFunction"],
          resources: [schedulerFunction.functionArn],
        }),
      );
      invocationRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ["sqs:SendMessage"],
          resources: [dlq.queueArn],
        }),
      );

      new scheduler.CfnSchedule(this, `${scheduleDefinition.name}Schedule`, {
        name: `${scheduleBaseName}-schedule`,
        scheduleExpression: scheduleDefinition.expression,
        flexibleTimeWindow: {
          mode: "OFF",
        },
        state: "ENABLED",
        target: {
          arn: schedulerFunction.functionArn,
          roleArn: invocationRole.roleArn,
          retryPolicy: {
            maximumRetryAttempts: retry.maxAttempts,
            maximumEventAgeInSeconds: retry.maxEventAgeSeconds,
          },
          deadLetterConfig: {
            arn: dlq.queueArn,
          },
          input: JSON.stringify({
            scheduleName: scheduleDefinition.name,
            targetHandler: handlerName,
          }),
        },
      });

      schedulerFunctions.push(schedulerFunction);
      schedulerDlqs.push(dlq);
    });

    this.schedulerFunctions = schedulerFunctions;
    this.schedulerDlqs = schedulerDlqs;
  }
}

function createLogGroup(
  scope: Construct,
  id: string,
  functionName: string,
  lambdaDefaults: LambdaDefaults,
  removalPolicy: RemovalPolicy,
): logs.LogGroup {
  return new logs.LogGroup(scope, id, {
    logGroupName: `/aws/lambda/${functionName}`,
    retention: lambdaDefaults.logRetention,
    removalPolicy,
  });
}

function outboxEnvironment(props: JawStackOutboxConstructProps): Record<string, string> {
  return {
    JAWSTACK_APP_NAME: props.appName,
    JAWSTACK_STAGE: props.stage,
    JAWSTACK_TABLE_NAME: props.table.tableName,
    JAWSTACK_EVENT_BUS_NAME: props.eventBus.eventBusName,
  };
}

function requireTableStreamArn(table: dynamodb.Table): string {
  if (table.tableStreamArn === undefined) {
    throw new Error("JawStack DynamoDB table stream ARN is required.");
  }

  return table.tableStreamArn;
}

function resourceNames(
  appName: string,
  stage: string,
): Readonly<{
  tableName: string;
  eventBusName: string;
  httpApiName: string;
  apiFunctionName: string;
  outboxDispatcherFunctionName: string;
  outboxSweeperFunctionName: string;
}> {
  const prefix = `${safeName(appName)}-${safeName(stage)}`;

  return {
    tableName: `${prefix}-resources`,
    eventBusName: `${prefix}-events`,
    httpApiName: `${prefix}-api`,
    apiFunctionName: `${prefix}-api`,
    outboxDispatcherFunctionName: `${prefix}-outbox-dispatcher`,
    outboxSweeperFunctionName: `${prefix}-outbox-sweeper`,
  };
}

function safeName(value: string): string {
  return value
    .trim()
    .replaceAll(/[^A-Za-z0-9-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function removalPolicyFor(
  stage: string,
  override: JawStackRemovalPolicy | undefined,
): RemovalPolicy {
  if (override === "destroy") {
    return RemovalPolicy.DESTROY;
  }

  if (override === "retain") {
    return RemovalPolicy.RETAIN;
  }

  return stage === "dev" ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
}

function lambdaDefaultsFromCostProfile(costProfile: CostProfile): LambdaDefaults {
  const lambdaProfile = recordProperty(costProfile, "lambda");
  const defaultTimeoutSeconds = numberProperty(lambdaProfile, "defaultTimeoutSeconds") ?? 15;
  const maxTimeoutSeconds = numberProperty(lambdaProfile, "maxTimeoutSeconds") ?? 30;
  const timeoutSeconds = Math.min(defaultTimeoutSeconds, maxTimeoutSeconds);
  const outboxTimeoutSeconds = Math.min(Math.max(defaultTimeoutSeconds, 30), maxTimeoutSeconds);

  return {
    timeout: Duration.seconds(timeoutSeconds),
    outboxTimeout: Duration.seconds(outboxTimeoutSeconds),
    memorySize: numberProperty(lambdaProfile, "defaultMemoryMb") ?? 512,
    reservedConcurrency: numberProperty(lambdaProfile, "reservedConcurrency") ?? 5,
    sweeperReservedConcurrency: 1,
    logRetention: logs.RetentionDays.ONE_WEEK,
  };
}

function queueDefaultsFromCostProfile(costProfile: CostProfile): QueueDefaults {
  const queueProfile = recordProperty(costProfile, "queues");

  return {
    defaultMaxConcurrency: numberProperty(queueProfile, "defaultMaxConcurrency") ?? 2,
    maxReceiveCount: numberProperty(queueProfile, "maxReceiveCount") ?? 3,
  };
}

function schedulerDefaultsFromCostProfile(costProfile: CostProfile): SchedulerDefaults {
  const schedulerProfile = recordProperty(costProfile, "scheduler");

  return {
    maxRetryAttempts: numberProperty(schedulerProfile, "maxRetryAttempts") ?? 2,
    maxEventAgeSeconds: numberProperty(schedulerProfile, "maxEventAgeSeconds") ?? 3600,
  };
}

function workersFromResources(resources: readonly ResourceDefinition[]): WorkerDefinition[] {
  return resources.flatMap((resource) => resource.workers);
}

function schedulesFromResources(resources: readonly ResourceDefinition[]): ScheduleDefinition[] {
  return resources.flatMap((resource) => resource.schedules);
}

function pointInTimeRecoveryFromCostProfile(costProfile: CostProfile): boolean {
  const dynamodbProfile = recordProperty(costProfile, "dynamodb");
  return booleanProperty(dynamodbProfile, "pointInTimeRecovery") ?? false;
}

function recordProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const property = (value as Record<string, unknown>)[key];
  return typeof property === "object" && property !== null && !Array.isArray(property)
    ? (property as Record<string, unknown>)
    : undefined;
}

function numberProperty(
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const property = value?.[key];
  return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}

function booleanProperty(
  value: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const property = value?.[key];
  return typeof property === "boolean" ? property : undefined;
}
