import { statSync } from "node:fs";
import { isDeepStrictEqual as equal } from "node:util";
import { Duration, RemovalPolicy, Tags } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import {
  copyWorkflowJson,
  createResourceRegistry,
  getWorkflowManifest,
  JawStackDefinitionError,
  type WorkflowDefinition,
} from "@jawstack/core";
import type { JawStackResourceWorkflowAppProps, JawStackWorkerBinding } from "./index";
import { safeName } from "./names";

export type JawStackRecoverableWorkers = Readonly<{
  definition: WorkflowDefinition;
  collectorHandler: string;
}>;
function invalid(message: string): never {
  throw new JawStackDefinitionError("cdk.recovery", message);
}
function own(input: unknown) {
  if (
    !input ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    invalid("Recovery options must be an own-property configuration.");
  for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input, key)!;
    if (typeof key !== "string" || !property.enumerable || !("value" in property))
      invalid("Recovery options cannot contain accessors or hidden properties.");
  }
  return Object.keys(input);
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function prepareRecoverableWorkers(
  props: JawStackResourceWorkflowAppProps,
  defaults: {
    timeoutSeconds: number;
    memorySize: number;
    reservedConcurrency: number;
    defaultMaxConcurrency: number;
    maxReceiveCount: number;
  },
) {
  const input = props.recoverableWorkers;
  if (input === undefined) return undefined;
  if (own(input).some((key) => !["definition", "collectorHandler"].includes(key)))
    invalid("Unknown recovery option.");
  const manifest = getWorkflowManifest(input.definition);
  const codePath = input.collectorHandler;
  if (typeof codePath !== "string" || !codePath.trim())
    invalid("Recovery requires a collector handler asset.");
  try {
    const asset = statSync(codePath);
    if (!asset.isDirectory() && !(asset.isFile() && codePath.endsWith(".zip")))
      invalid("Collector asset must be a directory or ZIP.");
  } catch {
    invalid("Collector handler asset must be an existing directory or ZIP.");
  }
  const registry = createResourceRegistry(props.resources);
  const names = registry.resources.map((resource) => resource.name).sort();
  const commands = registry.resources
    .flatMap((resource) =>
      Object.entries(resource.commands).map(([commandName, command]) => ({
        resourceType: resource.name,
        commandName,
        create: command.create,
        roles: [...command.roles].sort(),
        emits: command.emits
          .map((event) => ({ ...event }))
          .sort((a, b) =>
            compare(`${a.eventType}#${a.schemaVersion}`, `${b.eventType}#${b.schemaVersion}`),
          ),
      })),
    )
    .sort((a, b) =>
      compare(`${a.resourceType}#${a.commandName}`, `${b.resourceType}#${b.commandName}`),
    );
  if (!equal(names, manifest.resources) || !equal(commands, manifest.commandDefinitions))
    invalid("Recovery resources/command declarations differ from the workflow manifest.");
  const workers = registry.resources.flatMap((resource) => resource.workers);
  if (
    workers.length !== manifest.consumers.length ||
    workers.length > 40 ||
    new Set(workers.map((w) => w.name)).size !== workers.length
  )
    invalid("Recovery consumers must exactly match the workflow (maximum 40).");
  for (const worker of workers) {
    const declared = manifest.consumers.find((consumer) => consumer.name === worker.name);
    if (
      !declared ||
      worker.handler !== undefined ||
      !equal([...worker.eventTypes].sort(), declared.eventTypes) ||
      (worker.maxConcurrency ?? 2) !== declared.maxConcurrency
    )
      invalid("Recovery worker subscriptions/concurrency differ from the workflow manifest.");
    if (
      declared.timeoutSeconds !== 30 ||
      declared.visibilityTimeoutSeconds !== 180 ||
      declared.maxReceiveCount !== 3 ||
      declared.batchSize !== 1 ||
      declared.maxConcurrency !== 2
    )
      invalid("Recovery requires the reviewed 30s/180s/3-receive/batch-1/concurrency-2 profile.");
  }
  const cost = copyWorkflowJson(props.costProfile, 64 * 1024);
  for (const [section, fields] of [
    [
      "lambda",
      ["defaultTimeoutSeconds", "maxTimeoutSeconds", "defaultMemoryMb", "reservedConcurrency"],
    ],
    ["queues", ["defaultMaxConcurrency", "maxReceiveCount"]],
  ] as const) {
    const values = cost[section];
    if (values !== undefined) {
      own(values);
      for (const field of fields) {
        const value = (values as Record<string, unknown>)[field];
        if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 1))
          invalid("Recovery cost bounds must be positive safe integers.");
      }
    }
  }
  if (
    defaults.timeoutSeconds !== 30 ||
    defaults.memorySize !== 256 ||
    defaults.reservedConcurrency !== 2 ||
    defaults.defaultMaxConcurrency !== 2 ||
    defaults.maxReceiveCount !== 3
  )
    invalid(
      "Cost profile conflicts with the reviewed recovery bounds (30s/256MiB/concurrency 2/three receives).",
    );
  if (props.workerOptions) {
    if (
      own(props.workerOptions).some(
        (key) => !["batchSize", "deadLetterVisibilityTimeoutSeconds", "eventSource"].includes(key),
      ) ||
      (props.workerOptions.batchSize !== undefined && props.workerOptions.batchSize !== 1) ||
      (props.workerOptions.deadLetterVisibilityTimeoutSeconds !== undefined &&
        props.workerOptions.deadLetterVisibilityTimeoutSeconds !== 180) ||
      (props.workerOptions.eventSource !== undefined &&
        props.workerOptions.eventSource !== manifest.source)
    )
      invalid("Worker options conflict with the workflow recovery profile/source.");
  }
  if (!equal(own(props.entrypoints.workerHandlers ?? {}).sort(), workers.map((w) => w.name).sort()))
    invalid("Recovery worker handlers must exactly match the declared consumers.");
  const normalized = workers.map((worker) => safeName(worker.name));
  const prefix = `${safeName(props.appName)}-${safeName(props.stage)}`;
  if (
    !safeName(props.appName) ||
    !safeName(props.stage) ||
    new Set(normalized).size !== normalized.length ||
    normalized.some((name) => !name || `${prefix}-${name}-collector`.length > 64)
  )
    invalid("Recovery physical worker/collector names collide or exceed naming bounds.");
  return {
    manifest,
    codePath,
    prefix,
    workerOptions: {
      batchSize: 1,
      deadLetterVisibilityTimeoutSeconds: 180,
      eventSource: manifest.source,
    },
  };
}

export function createWorkflowCollectors(
  scope: Construct,
  input: {
    config: NonNullable<ReturnType<typeof prepareRecoverableWorkers>>;
    appName: string;
    stage: string;
    table: dynamodb.Table;
    eventBusName: string;
    workers: Readonly<Record<string, JawStackWorkerBinding | undefined>>;
    functions: readonly lambda.Function[];
    removalPolicy: RemovalPolicy;
  },
): Readonly<Record<string, lambda.Function | undefined>> {
  const { config, table } = input;
  const collectors: Record<string, lambda.Function> = Object.create(null);
  for (const consumer of config.manifest.consumers) {
    const binding = input.workers[consumer.name];
    if (!binding) invalid("Missing named worker binding for recovery.");
    const environment = {
      JAWSTACK_APP_NAME: input.appName,
      JAWSTACK_STAGE: input.stage,
      JAWSTACK_TABLE_NAME: table.tableName,
      JAWSTACK_EVENT_BUS_NAME: input.eventBusName,
      JAWSTACK_WORKER_NAME: consumer.name,
      JAWSTACK_WORKFLOW_NAME: config.manifest.name,
      JAWSTACK_WORKFLOW_HASH: config.manifest.hash,
      JAWSTACK_EVENT_SOURCE: config.manifest.source,
      JAWSTACK_SOURCE_QUEUE_ARN: binding.queue.queueArn,
      JAWSTACK_DEAD_LETTER_QUEUE_ARN: binding.deadLetterQueue.queueArn,
    };
    for (const [key, value] of Object.entries({ ...environment, JAWSTACK_WORKFLOW_ROLE: "worker" }))
      binding.workerFunction.addEnvironment(key, value);
    const functionName = `${config.prefix}-${safeName(consumer.name)}-collector`;
    const logGroup = new logs.LogGroup(scope, `${consumer.name}CollectorLogs`, {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: input.removalPolicy,
    });
    const role = new iam.Role(scope, `${consumer.name}CollectorRole`, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    logGroup.grantWrite(role);
    const collector = new lambda.Function(scope, `${consumer.name}Collector`, {
      functionName,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(config.codePath),
      handler: "index.handler",
      timeout: Duration.seconds(30),
      memorySize: 256,
      reservedConcurrentExecutions: 2,
      logGroup,
      role,
      environment: { ...environment, JAWSTACK_WORKFLOW_ROLE: "collector" },
    });
    collector.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:DeleteItem"],
        resources: [table.tableArn],
      }),
    );
    collector.addEventSource(
      new SqsEventSource(binding.deadLetterQueue, { batchSize: 1, maxConcurrency: 2 }),
    );
    collectors[consumer.name] = collector;
  }
  for (const fn of [...input.functions, ...Object.values(collectors)]) {
    fn.addEnvironment("JAWSTACK_WORKFLOW_NAME", config.manifest.name);
    fn.addEnvironment("JAWSTACK_WORKFLOW_HASH", config.manifest.hash);
    fn.addEnvironment("JAWSTACK_EVENT_SOURCE", config.manifest.source);
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:DescribeTable", "dynamodb:ListTagsOfResource"],
        resources: [table.tableArn],
      }),
    );
  }
  Tags.of(table).add("jawstack:workflow", config.manifest.hash);
  return Object.freeze(collectors);
}
