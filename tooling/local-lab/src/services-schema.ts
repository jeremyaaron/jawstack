import { z } from "zod";

const name = z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/);
const reference = z.string().min(1).max(512);
const integer = (max: number) => z.number().int().min(1).max(max);
const statement = z.strictObject({
  actions: z
    .array(
      z.enum([
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:TransactWriteItems",
        "dynamodb:DescribeTable",
        "dynamodb:ListTagsOfResource",
        "dynamodb:DescribeStream",
        "dynamodb:GetRecords",
        "dynamodb:GetShardIterator",
        "dynamodb:ListStreams",
        "events:PutEvents",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:SendMessage",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:GetBucketVersioning",
        "lambda:InvokeFunction",
      ]),
    )
    .min(1)
    .max(30),
  resources: z.array(reference).min(1).max(100),
});
export const servicesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workflowHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  tables: z.array(z.strictObject({ name })).max(2),
  buses: z.array(z.strictObject({ name })).max(2),
  buckets: z.array(z.strictObject({ name })).max(2),
  queues: z
    .array(
      z.strictObject({
        name,
        visibility: integer(900),
        retention: integer(1209600),
        dlq: name.optional(),
        receives: integer(5).optional(),
      }),
    )
    .max(100),
  roles: z
    .array(
      z.strictObject({
        name,
        service: z.enum(["lambda.amazonaws.com", "scheduler.amazonaws.com"]),
        policyName: name,
        statements: z.array(statement).min(1).max(30),
      }),
    )
    .max(100),
  functions: z
    .array(
      z.strictObject({
        name,
        role: name,
        timeout: integer(30),
        memory: z.literal(256),
        concurrency: z.literal(2),
        environment: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), z.string().max(1024)),
        ownerEnvironmentKey: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
          .optional(),
        profileEnvironmentKey: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
          .optional(),
        failureQueue: name.optional(),
      }),
    )
    .max(100),
  rules: z
    .array(
      z.strictObject({
        name,
        bus: name,
        source: z.string().min(1).max(200),
        eventTypes: z.array(z.string().min(1).max(200)).min(1).max(100),
        queue: name,
        targetId: name,
      }),
    )
    .max(100),
  mappings: z
    .array(
      z.strictObject({
        functionName: name,
        source: z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("queue"), name }),
          z.strictObject({ kind: z.literal("stream"), name }),
        ]),
        batchSize: integer(10),
        concurrency: z.literal(2).optional(),
      }),
    )
    .max(100),
  scheduleGroups: z.array(z.strictObject({ name })).max(2),
  schedules: z
    .array(
      z.strictObject({
        name,
        group: name,
        functionName: name,
        role: name,
        enabled: z.boolean(),
        input: z.record(z.string(), z.string().max(1024)),
        failureQueue: name.optional(),
      }),
    )
    .max(30),
});
export type ServicePlan = z.infer<typeof servicesSchema>;
