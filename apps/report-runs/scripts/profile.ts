import { archiveIdentity, arn, parseProfile, type ServicePlan } from "@jawstack/local-lab";
import { topology } from "../src/local-config";
import { reportDefinition } from "../src/workflow";
export async function reportProfile(labId: string, archives: Record<string, string>) {
  const t = topology(labId),
    manifest = reportDefinition(t.source).manifest,
    consumer = manifest.consumers[0]!;
  const functions = [
    {
      name: t.dispatcher,
      handler: "index.dispatcher",
      archive: await archiveIdentity(archives.outbox!),
    },
    { name: t.worker, handler: "index.handler", archive: await archiveIdentity(archives.worker!) },
    {
      name: t.collector,
      handler: "index.handler",
      archive: await archiveIdentity(archives.collector!),
    },
  ];
  const table = arn("table", t.table);
  const services: ServicePlan = {
    schemaVersion: 1,
    workflowHash: manifest.hash,
    tables: [{ name: t.table }],
    buses: [{ name: t.bus }],
    buckets: [],
    queues: [
      { name: t.dlq, visibility: consumer.visibilityTimeoutSeconds, retention: 1209600 },
      {
        name: t.queue,
        visibility: consumer.visibilityTimeoutSeconds,
        retention: 345600,
        dlq: t.dlq,
        receives: consumer.maxReceiveCount,
      },
    ],
    roles: functions.map((f) => ({
      name: f.name,
      service: "lambda.amazonaws.com",
      policyName: "workflow",
      statements: [
        {
          actions: ["dynamodb:DescribeTable", "dynamodb:ListTagsOfResource"] as const,
          resources: [table],
        },
        {
          actions: [
            "dynamodb:GetItem",
            "dynamodb:Query",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
            "dynamodb:TransactWriteItems",
          ] as const,
          resources: [table, table + "/index/*"],
        },
        {
          actions: ["logs:CreateLogStream", "logs:PutLogEvents"] as const,
          resources: [arn("log", f.name)],
        },
        ...(f.name === t.dispatcher
          ? [
              {
                actions: [
                  "dynamodb:DescribeStream",
                  "dynamodb:GetRecords",
                  "dynamodb:GetShardIterator",
                  "dynamodb:ListStreams",
                ] as const,
                resources: [table + "/stream/*"],
              },
              { actions: ["events:PutEvents"] as const, resources: [arn("bus", t.bus)] },
            ]
          : [
              {
                actions: [
                  "sqs:ReceiveMessage",
                  "sqs:DeleteMessage",
                  "sqs:GetQueueAttributes",
                ] as const,
                resources: [arn("queue", f.name === t.worker ? t.queue : t.dlq)],
              },
            ]),
      ].map((statement) => ({ ...statement, actions: [...statement.actions] })),
    })),
    functions: functions.map((f) => ({
      name: f.name,
      role: f.name,
      timeout: consumer.timeoutSeconds,
      memory: 256,
      concurrency: 2,
      environment: { REPORT_RUNS_LAB_ID: labId },
      ownerEnvironmentKey: "REPORT_RUNS_OWNER_ID",
      profileEnvironmentKey: "REPORT_RUNS_PROFILE_HASH",
    })),
    rules: [
      {
        name: t.project + "-requested",
        bus: t.bus,
        source: manifest.source,
        eventTypes: [...consumer.eventTypes],
        queue: t.queue,
        targetId: "inventory",
      },
    ],
    mappings: [
      { functionName: t.dispatcher, source: { kind: "stream", name: t.table }, batchSize: 10 },
      {
        functionName: t.worker,
        source: { kind: "queue", name: t.queue },
        batchSize: consumer.batchSize,
        concurrency: 2,
      },
      {
        functionName: t.collector,
        source: { kind: "queue", name: t.dlq },
        batchSize: consumer.batchSize,
        concurrency: 2,
      },
    ],
    scheduleGroups: [],
    schedules: [],
  };
  return parseProfile({
    schemaVersion: 1,
    instanceId: labId,
    project: t.project,
    functions,
    resources: {
      tables: [t.table],
      buses: [t.bus],
      queues: [t.queue, t.dlq],
      roles: functions.map((f) => f.name),
      buckets: [],
      scheduleGroups: [],
    },
    services,
  });
}
