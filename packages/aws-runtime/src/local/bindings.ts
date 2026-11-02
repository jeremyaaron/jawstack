import { z } from "zod";
import { copyWorkflowJson, JawStackDefinitionError, type WorkflowReadonly } from "@jawstack/core";

const identity = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const resourceName = z.string().regex(/^[a-z][a-z0-9-]{2,62}$/);
const functionSchema = z
  .strictObject({
    name: resourceName,
    role: z.enum(["api", "dispatcher", "worker", "collector", "jobs", "proof"]),
    consumer: identity.optional(),
  })
  .refine(
    (value) => ["worker", "collector"].includes(value.role) === (value.consumer !== undefined),
  );
const bindingsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workflow: z.strictObject({ name: identity, source: z.string().min(1).max(200), hash }),
  profile: z.strictObject({ name: identity, hash }),
  lab: z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,15}$/),
    project: resourceName,
    ownerId: z.uuid(),
  }),
  accountId: z.literal("000000000000"),
  region: z.literal("us-east-1"),
  tableName: resourceName,
  eventBusName: resourceName,
  functions: z.array(functionSchema).min(1).max(100),
  consumers: z
    .array(
      z.strictObject({
        consumer: identity,
        sourceQueueArn: z.string().max(256),
        deadLetterQueueArn: z.string().max(256),
      }),
    )
    .min(1)
    .max(40),
  services: z
    .strictObject({
      bucketName: resourceName.optional(),
      scheduleGroupName: resourceName.optional(),
    })
    .optional(),
});
export type LocalWorkflowBindings = WorkflowReadonly<z.infer<typeof bindingsSchema>>;
export type LocalWorkflowFunction = LocalWorkflowBindings["functions"][number];
export type LocalWorkflowExecution =
  | Readonly<{ kind: "host" }>
  | Readonly<{
      kind: "lambda";
      functionName: string;
      invokedFunctionArn: string;
      role: LocalWorkflowFunction["role"];
      consumer?: string | undefined;
    }>;
export function localConfigurationError(): never {
  throw new JawStackDefinitionError(
    "workflow.local",
    "Invalid or unsafe local workflow configuration.",
  );
}
function freeze<T>(input: T): WorkflowReadonly<T> {
  if (input && typeof input === "object") {
    for (const child of Object.values(input)) freeze(child);
    Object.freeze(input);
  }
  return input as WorkflowReadonly<T>;
}
export function parseLocalWorkflowBindings(input: unknown): LocalWorkflowBindings {
  try {
    if (typeof input === "string") {
      if (Buffer.byteLength(input) > 64 * 1024) localConfigurationError();
      input = JSON.parse(input);
    }
    const value = bindingsSchema.parse(copyWorkflowJson(input, 64 * 1024));
    const prefix = `${value.lab.project}-`;
    if (
      ![
        value.tableName,
        value.eventBusName,
        ...value.functions.map((f) => f.name),
        ...Object.values(value.services ?? {}),
      ].every((name) => typeof name === "string" && name.startsWith(prefix))
    )
      localConfigurationError();
    const names = value.functions.map((f) => f.name),
      consumers = value.consumers.map((c) => c.consumer);
    if (new Set(names).size !== names.length || new Set(consumers).size !== consumers.length)
      localConfigurationError();
    const queues: string[] = [];
    for (const consumer of value.consumers) {
      for (const role of ["worker", "collector"]) {
        if (
          value.functions.filter((f) => f.role === role && f.consumer === consumer.consumer)
            .length !== 1
        )
          localConfigurationError();
      }
      for (const arn of [consumer.sourceQueueArn, consumer.deadLetterQueueArn]) {
        const base = `arn:aws:sqs:${value.region}:${value.accountId}:`;
        if (
          !arn.startsWith(base) ||
          !/^[a-z][a-z0-9-]{2,79}$/.test(arn.slice(base.length)) ||
          !arn.slice(base.length).startsWith(prefix)
        )
          localConfigurationError();
        queues.push(arn);
      }
    }
    if (
      new Set(queues).size !== queues.length ||
      value.functions.some((f) => f.consumer !== undefined && !consumers.includes(f.consumer))
    )
      localConfigurationError();
    for (const role of ["api", "dispatcher", "jobs"])
      if (value.functions.filter((f) => f.role === role).length > 1) localConfigurationError();
    if (value.functions.some((f) => f.role === "jobs") && !value.services?.scheduleGroupName)
      localConfigurationError();
    return freeze(value);
  } catch {
    return localConfigurationError();
  }
}

export function localExecution(input: LocalWorkflowExecution): LocalWorkflowExecution {
  try {
    const value = z
      .discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("host") }),
        z
          .strictObject({
            kind: z.literal("lambda"),
            functionName: resourceName,
            invokedFunctionArn: z.string().min(1).max(256),
            role: functionSchema.shape.role,
            consumer: identity.optional(),
          })
          .refine((v) => ["worker", "collector"].includes(v.role) === (v.consumer !== undefined)),
      ])
      .parse(copyWorkflowJson(input, 1024));
    if (
      value.kind === "lambda" &&
      value.invokedFunctionArn !==
        `arn:aws:lambda:us-east-1:000000000000:function:${value.functionName}`
    )
      localConfigurationError();
    return freeze(value);
  } catch {
    return localConfigurationError();
  }
}

export function localObject(input: unknown): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    localConfigurationError();
  for (const key of Reflect.ownKeys(input)) {
    const property = Object.getOwnPropertyDescriptor(input, key)!;
    if (typeof key !== "string" || !property.enumerable || !("value" in property))
      localConfigurationError();
  }
  return input as Record<string, unknown>;
}
