import { Construct } from "constructs";
import { Duration, RemovalPolicy, Stack, Tags, Token } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as destinations from "aws-cdk-lib/aws-lambda-destinations";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { JawStackResourceWorkflowApp } from "@jawstack/aws-cdk";
import { contentInfrastructureConfig, type InfrastructureArtifact } from "./config";

export class ContentOperationsInfrastructure extends Construct {
  readonly workflow: JawStackResourceWorkflowApp;
  readonly bucket: s3.Bucket;
  readonly collectorsByName: Readonly<Record<string, lambda.Function | undefined>>;
  readonly jobFailures: sqs.Queue;
  readonly config: ReturnType<typeof contentInfrastructureConfig>;

  constructor(
    scope: Construct,
    id: string,
    options: {
      entrypoints: Record<InfrastructureArtifact, string>;
      stage?: string;
      runtime?: string;
      labId?: string;
    },
  ) {
    super(scope, id);
    const config = contentInfrastructureConfig(options);
    this.config = config;
    const stack = Stack.of(this);
    if (
      (!Token.isUnresolved(stack.account) && stack.account !== "000000000000") ||
      (!Token.isUnresolved(stack.region) && stack.region !== config.lab.region)
    )
      throw new Error("Content synthesis uses only the dummy local account and declared region.");
    const { profile } = config;
    const bounds = profile.bounds;
    const prefix = `${config.appName}-${config.stage}`;
    this.workflow = new JawStackResourceWorkflowApp(this, "Workflow", {
      appName: config.appName,
      stage: config.stage,
      resources: config.resources,
      costProfile: config.costProfile,
      auth: config.auth,
      removalPolicy: "destroy",
      workerOptions: {
        batchSize: bounds.batchSize,
        deadLetterVisibilityTimeoutSeconds: bounds.visibility,
        eventSource: config.lab.source,
      },
      entrypoints: {
        apiHandler: options.entrypoints.api,
        outboxHandler: options.entrypoints.outbox,
        workerHandlers: Object.fromEntries(
          profile.workers.map((worker) => [worker.consumer, options.entrypoints.worker]),
        ),
        schedulerHandlers: Object.fromEntries(
          profile.schedules.map((job) => [job.targetHandler, options.entrypoints.scheduler]),
        ),
      },
    });
    this.bucket = new s3.Bucket(this, "Artifacts", {
      bucketName: config.lab.bucket,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });
    this.jobFailures = new sqs.Queue(this, "AsyncJobFailures", {
      retentionPeriod: Duration.seconds(bounds.dlqRetention),
      visibilityTimeout: Duration.seconds(bounds.visibility),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const environment = (fn: lambda.Function) => {
      for (const [key, value] of Object.entries({
        CONTENT_OPS_LAB_ID: config.lab.instanceId,
        CONTENT_OPS_STAGE: config.stage,
        CONTENT_OPS_RUNTIME: config.runtime,
        CONTENT_OPS_SYNTH_ONLY: "true",
        CONTENT_OPS_BUCKET_NAME: this.bucket.bucketName,
        CONTENT_OPS_EVENT_SOURCE: config.lab.source,
        JAWSTACK_STAGE: config.stage,
        JAWSTACK_AUTH_MODE: config.auth.mode,
        JAWSTACK_AUTH_PROVIDER: config.auth.provider,
        JAWSTACK_TABLE_NAME: this.workflow.table.tableName,
        JAWSTACK_EVENT_BUS_NAME: this.workflow.eventBus.eventBusName,
      }))
        fn.addEnvironment(key, value);
    };
    const grantObjects = (fn: lambda.Function, actions: string[], prefix: string) =>
      fn.addToRolePolicy(
        new PolicyStatement({ actions, resources: [this.bucket.arnForObjects(`${prefix}/*`)] }),
      );
    for (const fn of [
      this.workflow.apiFunction,
      this.workflow.outboxDispatcherFunction,
      this.workflow.outboxSweeperFunction,
    ])
      environment(fn);
    grantObjects(this.workflow.apiFunction, ["s3:GetObject", "s3:PutObject"], "assets");
    grantObjects(this.workflow.apiFunction, ["s3:GetObject"], "publications");
    const collectors: Record<string, lambda.Function> = Object.create(null);
    for (const worker of profile.workers) {
      const binding = this.workflow.workerBindingsByName[worker.consumer];
      if (!binding) throw new Error(`Missing named worker ${worker.consumer}.`);
      environment(binding.workerFunction);
      binding.workerFunction.addEnvironment("CONTENT_OPS_CONSUMER", worker.consumer);
      binding.workerFunction.addEnvironment("CONTENT_OPS_QUEUE_ARN", binding.queue.queueArn);
      if (worker.consumer === "publishContent") {
        grantObjects(binding.workerFunction, ["s3:GetObject"], "assets");
        grantObjects(binding.workerFunction, ["s3:GetObject", "s3:PutObject"], "publications");
      }
      const name = `${prefix}-${worker.consumer.toLowerCase()}-collector`;
      const logGroup = new logs.LogGroup(this, `${worker.consumer}CollectorLogs`, {
        logGroupName: `/aws/lambda/${name}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      const collector = new lambda.Function(this, `${worker.consumer}Collector`, {
        functionName: name,
        code: lambda.Code.fromAsset(options.entrypoints.collector),
        handler: "index.handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: Duration.seconds(bounds.timeout),
        memorySize: bounds.memory,
        reservedConcurrentExecutions: bounds.concurrency,
        logGroup,
      });
      environment(collector);
      collector.addEnvironment("CONTENT_OPS_CONSUMER", worker.consumer);
      collector.addEnvironment("CONTENT_OPS_QUEUE_ARN", binding.deadLetterQueue.queueArn);
      this.workflow.table.grantReadWriteData(collector);
      collector.addEventSource(
        new SqsEventSource(binding.deadLetterQueue, {
          batchSize: bounds.batchSize,
          maxConcurrency: bounds.concurrency,
        }),
      );
      collectors[worker.consumer] = collector;
    }
    this.collectorsByName = Object.freeze(collectors);
    for (const job of profile.schedules) {
      const fn = this.workflow.schedulerFunctionsByName[job.name];
      if (!fn) throw new Error(`Missing named schedule ${job.name}.`);
      environment(fn);
      this.workflow.table.grantReadWriteData(fn);
      if (job.name === "cleanupOrphans") {
        grantObjects(fn, ["s3:GetObject", "s3:DeleteObject"], "assets");
        fn.addToRolePolicy(
          new PolicyStatement({
            actions: ["s3:GetBucketVersioning"],
            resources: [this.bucket.bucketArn],
          }),
        );
      }
      fn.configureAsyncInvoke({
        retryAttempts: 0,
        maxEventAge: Duration.seconds(60),
        onFailure: new destinations.SqsDestination(this.jobFailures),
      });
    }
    Tags.of(this).add("jawstack:consumer", "content-operations");
    Tags.of(this).add("jawstack:stage", "local");
  }
}
