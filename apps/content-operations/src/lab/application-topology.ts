import type { ServicePlan } from "@jawstack/local-lab";
import { arn } from "@jawstack/local-lab";
import { applicationProfile } from "../aws/profile";
import { labFunctions, type LabConfig } from "./config";

export function contentServicePlan(c: LabConfig): ServicePlan {
  const a = applicationProfile(c),
    table = arn("table", c.table),
    bucket = `arn:aws:s3:::${c.bucket}`;
  const ddb = [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:TransactWriteItems",
  ] as const;
  const log = (name: string) => ({
    actions: ["logs:CreateLogStream", "logs:PutLogEvents"] as const,
    resources: [arn("log", name)],
  });
  const statements: ServicePlan["roles"][number]["statements"] = [
    { actions: [...ddb], resources: [table] },
    {
      actions: [
        "dynamodb:DescribeStream",
        "dynamodb:GetRecords",
        "dynamodb:GetShardIterator",
        "dynamodb:ListStreams",
      ],
      resources: [`${table}/stream/*`],
    },
    { actions: ["events:PutEvents"], resources: [arn("bus", c.bus)] },
    {
      actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
      resources: [arn("queue", c.queue), arn("queue", c.dlq)],
    },
    {
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: labFunctions(c).map((f) => arn("log", f.name)),
    },
    { actions: ["s3:GetObject", "s3:PutObject"], resources: [`${bucket}/proofs/*`] },
  ];
  return {
    schemaVersion: 1,
    tables: [{ name: c.table }],
    buses: [{ name: c.bus }],
    buckets: [{ name: c.bucket }],
    queues: [
      { name: c.dlq, visibility: 30, retention: 1209600 },
      { name: c.queue, visibility: 30, retention: 345600, dlq: c.dlq, receives: 3 },
      { name: a.schedulerDlq, visibility: 180, retention: 1209600 },
      ...a.workers.flatMap((w) => [
        { name: w.dlq, visibility: 180, retention: 1209600 },
        { name: w.queue, visibility: 180, retention: 345600, dlq: w.dlq, receives: 3 },
      ]),
    ],
    roles: [
      { name: c.role, service: "lambda.amazonaws.com", policyName: "spine", statements },
      {
        name: c.schedulerRole,
        service: "scheduler.amazonaws.com",
        policyName: "invoke-tick",
        statements: [
          { actions: ["lambda:InvokeFunction"], resources: [arn("function", c.scheduled)] },
        ],
      },
      ...a.functions.map((f) => ({
        name: f.name,
        service: "lambda.amazonaws.com" as const,
        policyName: "application",
        statements: [
          {
            actions: [
              ...ddb,
              "dynamodb:Query",
            ] as ServicePlan["roles"][number]["statements"][number]["actions"],
            resources: [table, `${table}/index/*`],
          },
          { actions: [...log(f.name).actions], resources: log(f.name).resources },
          ...(f.queue
            ? [
                {
                  actions: [
                    "sqs:ReceiveMessage",
                    "sqs:DeleteMessage",
                    "sqs:GetQueueAttributes",
                  ] as const,
                  resources: [arn("queue", f.queue)],
                },
              ]
            : []
          ).map((s) => ({ ...s, actions: [...s.actions] })),
          ...(f.objects === "publication"
            ? [
                {
                  actions: ["s3:GetObject"] as const,
                  resources: [`${bucket}/assets/*`, `${bucket}/publications/*`],
                },
                { actions: ["s3:PutObject"] as const, resources: [`${bucket}/publications/*`] },
              ]
            : []
          ).map((s) => ({ ...s, actions: [...s.actions] })),
          ...(f.objects === "cleanup"
            ? [
                {
                  actions: ["s3:GetObject", "s3:DeleteObject"] as const,
                  resources: [`${bucket}/assets/*`],
                },
                { actions: ["s3:GetBucketVersioning"] as const, resources: [bucket] },
                {
                  actions: ["sqs:SendMessage"] as const,
                  resources: [arn("queue", a.schedulerDlq)],
                },
              ]
            : []
          ).map((s) => ({ ...s, actions: [...s.actions] })),
        ],
      })),
      {
        name: a.schedulerRole,
        service: "scheduler.amazonaws.com",
        policyName: "application",
        statements: [
          { actions: ["lambda:InvokeFunction"], resources: [arn("function", a.jobs)] },
          { actions: ["sqs:SendMessage"], resources: [arn("queue", a.schedulerDlq)] },
        ],
      },
    ],
    functions: [
      ...labFunctions(c).map((f) => ({
        name: f.name,
        role: c.role,
        timeout: f.timeout,
        memory: 256 as const,
        concurrency: 2 as const,
        environment: { CONTENT_OPS_LAB_ID: c.instanceId },
        ownerEnvironmentKey: "CONTENT_OPS_OWNER_ID",
      })),
      ...a.functions.map((f) => ({
        name: f.name,
        role: f.name,
        timeout: 30,
        memory: 256 as const,
        concurrency: 2 as const,
        environment: {
          CONTENT_OPS_LAB_ID: c.instanceId,
          CONTENT_OPS_RUNTIME: "localstack",
          CONTENT_OPS_STAGE: "local",
          ...(f.consumer ? { CONTENT_OPS_CONSUMER: f.consumer } : {}),
        },
        ownerEnvironmentKey: "CONTENT_OPS_OWNER_ID",
        ...(!f.queue ? { failureQueue: a.schedulerDlq } : {}),
      })),
    ],
    rules: [
      {
        name: c.rule,
        bus: c.bus,
        source: c.source,
        eventTypes: ["spineProof.created"],
        queue: c.queue,
        targetId: "proof-queue",
      },
      ...a.workers.map((w) => ({
        name: w.rule,
        bus: c.bus,
        source: c.source,
        eventTypes: w.eventTypes,
        queue: w.queue,
        targetId: "consumer",
      })),
    ],
    mappings: [
      { functionName: c.dispatcher, source: { kind: "stream", name: c.table }, batchSize: 10 },
      {
        functionName: c.worker,
        source: { kind: "queue", name: c.queue },
        batchSize: 1,
        concurrency: 2,
      },
      {
        functionName: c.collector,
        source: { kind: "queue", name: c.dlq },
        batchSize: 1,
        concurrency: 2,
      },
      ...a.functions
        .filter((f) => f.queue)
        .map((f) => ({
          functionName: f.name,
          source: { kind: "queue" as const, name: f.queue! },
          batchSize: 1,
          concurrency: 2 as const,
        })),
    ],
    scheduleGroups: [{ name: c.scheduleGroup }],
    schedules: [
      {
        name: c.schedule,
        group: c.scheduleGroup,
        functionName: c.scheduled,
        role: c.schedulerRole,
        enabled: false,
        input: { targetHandler: "spineTick", runId: "inactive" },
      },
      ...a.schedules.map((s) => ({
        name: s.name,
        group: c.scheduleGroup,
        functionName: a.jobs,
        role: a.schedulerRole,
        enabled: true,
        input: { targetHandler: s.targetHandler },
        failureQueue: a.schedulerDlq,
      })),
    ],
  };
}
