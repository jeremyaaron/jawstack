import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  createResourceRegistry,
  JawStackDefinitionError,
  JawStackRuntimeError,
  type ResourceDefinition,
  type JawStackEvent,
} from "../index";
import {
  createWorkflowCommitPlanner,
  type WorkflowCommitContributor,
  type WorkflowCommitPlanner,
} from "./commit-plan";
import { createFailureProtocol } from "./failure-records";
import { registerRecords, type AtomicRecordDefinition } from "./records";
import { workflowRecordKeys } from "./keys";
import {
  component,
  freeze,
  jsonCopy,
  plainObject,
  synchronous,
  type WorkflowReadonly,
} from "./validation";

export type WorkflowEventDefinition = Readonly<{
  eventType: string;
  schemaVersion: number;
  schema: z.ZodType<Record<string, unknown>>;
  validateIdentity(event: WorkflowReadonly<JawStackEvent<Record<string, unknown>>>): boolean;
}>;
export type WorkflowConsumerPolicy = Readonly<{
  recovery: "replay" | "application";
  timeoutSeconds?: number;
  visibilityTimeoutSeconds?: number;
  maxReceiveCount?: 3;
  batchSize?: number;
}>;
export type DefineWorkflowInput = Readonly<{
  name: string;
  source: string;
  resources: readonly ResourceDefinition[];
  commands: Readonly<{ idempotencyTtlSeconds: number; maxActions?: number }>;
  records?: readonly AtomicRecordDefinition[];
  contribute?: WorkflowCommitContributor;
  events: readonly WorkflowEventDefinition[];
  eventBytes?: number;
  consumers: Readonly<Record<string, WorkflowConsumerPolicy>>;
  operations: Readonly<{ resourceType: string; projection: string }>;
}>;
declare const workflowBrand: unique symbol;
export interface WorkflowDefinition {
  readonly [workflowBrand]: true;
  readonly manifest: WorkflowManifest;
}
export type WorkflowManifest = WorkflowReadonly<{
  schemaVersion: 1;
  name: string;
  source: string;
  resources: string[];
  commandDefinitions: {
    resourceType: string;
    commandName: string;
    create: boolean;
    roles: string[];
    emits: { eventType: string; schemaVersion: number }[];
  }[];
  commands: { idempotencyTtlSeconds: number; maxActions: number };
  records: string[];
  events: { eventType: string; schemaVersion: number }[];
  eventBytes: number;
  consumers: {
    name: string;
    eventTypes: string[];
    recovery: "replay" | "application";
    timeoutSeconds: number;
    visibilityTimeoutSeconds: number;
    maxReceiveCount: 3;
    batchSize: number;
    maxConcurrency: number;
  }[];
  operations: { resourceType: string; projection: string };
  hash: string;
}>;
const definitions = new WeakMap<object, ReturnType<typeof build>>();
export function workflowDefinition(input: WorkflowDefinition) {
  const value = definitions.get(input);
  if (!value)
    throw new JawStackDefinitionError(
      "workflow.definition",
      "Expected an owned workflow definition.",
    );
  return value;
}
export function getWorkflowManifest(input: WorkflowDefinition): WorkflowManifest {
  return workflowDefinition(input).manifest;
}
export function workflowDefinitionError(message: string): never {
  throw new JawStackDefinitionError("workflow.definition", message);
}
export function ownEntries(input: unknown): [string, unknown][] {
  if (!plainObject(input))
    return workflowDefinitionError("Expected a plain own-property configuration.");
  return Reflect.ownKeys(input).map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor))
      return workflowDefinitionError(
        "Configuration cannot contain accessors, symbols or hidden properties.",
      );
    return [key, descriptor.value];
  });
}
function build(input: DefineWorkflowInput) {
  const registry = createResourceRegistry(input.resources);
  component(input.name);
  const commands = z
    .strictObject({
      idempotencyTtlSeconds: z.number().int().min(1).max(604800),
      maxActions: z.number().int().min(1).max(60).default(60),
    })
    .parse(jsonCopy(input.commands));
  const operations = z
    .strictObject({ resourceType: z.string(), projection: z.string() })
    .parse(jsonCopy(input.operations));
  if (!registry.getResource(operations.resourceType))
    workflowDefinitionError("Operations require a registered resource namespace.");
  const records = Object.freeze([...(input.records ?? [])]);
  const registeredRecords = registerRecords(records);
  const workers = registry.resources.flatMap((r) => r.workers);
  if (!workers.length || new Set(workers.map((w) => w.name)).size !== workers.length)
    workflowDefinitionError("Workflow consumers need unique declared workers.");
  const policyEntries = ownEntries(input.consumers);
  if (
    policyEntries.length !== workers.length ||
    policyEntries.some(([name]) => !workers.some((w) => w.name === name))
  )
    workflowDefinitionError("Consumer policies must exactly match declared workers.");
  const policySchema = z.strictObject({
    recovery: z.enum(["replay", "application"]),
    timeoutSeconds: z.number().int().min(1).max(900).default(30),
    visibilityTimeoutSeconds: z.number().int().min(1).max(43200).default(180),
    maxReceiveCount: z.literal(3).default(3),
    batchSize: z.number().int().min(1).max(10).default(1),
  });
  const consumers = workers
    .map((worker) => {
      const policy = policySchema.parse(
        jsonCopy(policyEntries.find(([name]) => name === worker.name)![1]),
      );
      if (
        policy.visibilityTimeoutSeconds < policy.timeoutSeconds * 6 ||
        (worker.maxConcurrency !== undefined &&
          (!Number.isInteger(worker.maxConcurrency) ||
            worker.maxConcurrency < 1 ||
            worker.maxConcurrency > 10000)) ||
        new Set(worker.eventTypes).size !== worker.eventTypes.length ||
        worker.handler !== undefined
      )
        workflowDefinitionError(
          "Invalid delivery bounds or embedded worker handler; use runtime binding.",
        );
      return {
        name: worker.name,
        eventTypes: [...worker.eventTypes].sort(),
        ...policy,
        maxConcurrency: worker.maxConcurrency ?? 2,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const profiles = consumers.map((c) =>
    JSON.stringify([
      c.timeoutSeconds,
      c.visibilityTimeoutSeconds,
      c.maxReceiveCount,
      c.batchSize,
      c.maxConcurrency,
    ]),
  );
  if (new Set(profiles).size !== 1)
    workflowDefinitionError("Managed consumers must share one delivery-bound profile.");
  const eventDefinitions = input.events.map((event) => {
    if (
      ownEntries(event).some(
        ([key]) => !["eventType", "schemaVersion", "schema", "validateIdentity"].includes(key),
      )
    )
      workflowDefinitionError("Unknown fact registration option.");
    if (
      !(event.schema instanceof z.ZodObject) ||
      "delivery" in event.schema.shape ||
      typeof event.validateIdentity !== "function"
    )
      workflowDefinitionError("Workflow facts require object schemas and identity validation.");
    component(event.eventType);
    if (!Number.isSafeInteger(event.schemaVersion) || event.schemaVersion < 1)
      workflowDefinitionError("Invalid fact schema version.");
    return Object.freeze({
      eventType: event.eventType,
      schemaVersion: event.schemaVersion,
      schema: event.schema.strict(),
      validateIdentity: event.validateIdentity,
    });
  });
  const eventKey = (event: { eventType: string; schemaVersion: number }) =>
    `${event.eventType}#${event.schemaVersion}`;
  const events = new Map(eventDefinitions.map((e) => [eventKey(e), e]));
  if (!events.size || events.size !== eventDefinitions.length)
    workflowDefinitionError("Duplicate or empty event registration.");
  for (const resource of registry.resources)
    for (const command of Object.values(resource.commands)) {
      if (new Set(command.emits.map(eventKey)).size !== command.emits.length)
        workflowDefinitionError("Duplicate command fact declaration.");
      for (const event of command.emits)
        if (!events.has(eventKey(event)))
          workflowDefinitionError("Every command fact must have a schema.");
    }
  for (const consumer of consumers)
    for (const name of consumer.eventTypes)
      if (!eventDefinitions.some((e) => e.eventType === name))
        workflowDefinitionError("Worker subscription has no registered fact schema.");
  const protocol = createFailureProtocol({
    source: input.source,
    resourceType: operations.resourceType,
    projectionName: operations.projection,
    consumers: consumers.map(({ name, eventTypes, recovery }) => ({ name, eventTypes, recovery })),
    ...(input.eventBytes === undefined ? {} : { eventBytes: input.eventBytes }),
    normalizePayload: (event) => {
      const definition = events.get(eventKey(event));
      if (!definition || !registry.getResource(event.resourceType)) throw new Error();
      const payload = jsonCopy(definition.schema.parse(event.payload));
      if (!isDeepStrictEqual(payload, definition.schema.parse(jsonCopy(payload))))
        throw new Error();
      return payload;
    },
    validateEvent: (event) => {
      const definition = events.get(eventKey(event));
      if (!definition || synchronous(definition.validateIdentity(freeze(jsonCopy(event)))) !== true)
        throw new Error();
    },
  });
  const parseRaw = (input: unknown) => {
    const copy = jsonCopy(input, 128 * 1024);
    if (plainObject(copy) && "detail" in copy) {
      const outer = copy;
      if ("tenantId" in outer) throw new Error("Tenant envelopes are unsupported.");
      if (typeof outer.detail === "string") {
        try {
          outer.detail = JSON.parse(outer.detail);
        } catch {
          throw new Error("Invalid wrapped fact.");
        }
      }
      const event = protocol.wire(outer.detail);
      if (
        ("source" in outer && outer.source !== event.source) ||
        ("detail-type" in outer && outer["detail-type"] !== event.eventType)
      )
        throw new Error("Wrapped fact identity mismatch.");
      return event;
    }
    return protocol.wire(copy);
  };
  const parse = (input: unknown) => {
    try {
      return parseRaw(input);
    } catch {
      throw new JawStackRuntimeError("command.validation", "Invalid workflow fact envelope.");
    }
  };
  const fact = (input: unknown) => {
    const event = parse(input);
    if ("delivery" in event.payload)
      throw new JawStackRuntimeError(
        "command.validation",
        "Command facts cannot author delivery metadata.",
      );
    return event;
  };
  const reservedPartition = workflowRecordKeys.projection(operations.resourceType, {
    projectionName: operations.projection,
    itemId: "check",
    sort: "check",
  }).partition;
  const basePlanner = createWorkflowCommitPlanner({
    workflowName: input.name,
    source: input.source,
    ...commands,
    records,
    ...(input.contribute === undefined ? {} : { contribute: input.contribute }),
  });
  const planner: WorkflowCommitPlanner = Object.freeze({
    ...basePlanner,
    plan: (...[invocation, commit]: Parameters<typeof basePlanner.plan>) => {
      const plan = basePlanner.plan(invocation, { ...commit, outbox: commit.outbox.map(fact) });
      if (
        plan.actions.some(
          (a) =>
            (a.kind === "projection" || a.kind === "projectionDelete") &&
            a.key.partition === reservedPartition,
        )
      )
        throw new JawStackRuntimeError(
          "command.rejected",
          "Operational projections are framework-owned.",
        );
      return plan;
    },
  });
  const manifestData = jsonCopy({
    schemaVersion: 1 as const,
    name: input.name,
    source: input.source,
    resources: registry.resources.map((r) => r.name).sort(),
    commandDefinitions: registry.resources
      .flatMap((r) =>
        Object.entries(r.commands).map(([commandName, command]) => ({
          resourceType: r.name,
          commandName,
          create: command.create,
          roles: [...command.roles].sort(),
          emits: command.emits
            .map((e) => ({ ...e }))
            .sort((a, b) => (eventKey(a) < eventKey(b) ? -1 : eventKey(a) > eventKey(b) ? 1 : 0)),
        })),
      )
      .sort((a, b) =>
        `${a.resourceType}#${a.commandName}` < `${b.resourceType}#${b.commandName}`
          ? -1
          : `${a.resourceType}#${a.commandName}` > `${b.resourceType}#${b.commandName}`
            ? 1
            : 0,
      ),
    commands,
    records: records.map((r) => r.name).sort(),
    events: eventDefinitions
      .map(({ eventType, schemaVersion }) => ({ eventType, schemaVersion }))
      .sort((a, b) => (eventKey(a) < eventKey(b) ? -1 : eventKey(a) > eventKey(b) ? 1 : 0)),
    eventBytes: input.eventBytes ?? 80 * 1024,
    consumers,
    operations,
  });
  const manifest = freeze({
    ...manifestData,
    hash: createHash("sha256").update(JSON.stringify(manifestData)).digest("hex"),
  });
  return Object.freeze({
    registry,
    records,
    registeredRecords,
    consumers: freeze(consumers),
    protocol,
    planner,
    manifest,
    parse,
    fact,
  });
}
export function defineWorkflow(input: DefineWorkflowInput): WorkflowDefinition {
  try {
    if (
      ownEntries(input).some(
        ([key]) =>
          ![
            "name",
            "source",
            "resources",
            "commands",
            "records",
            "contribute",
            "events",
            "eventBytes",
            "consumers",
            "operations",
          ].includes(key),
      )
    )
      workflowDefinitionError("Unknown workflow option.");
    const data = build(input);
    const definition = Object.freeze({ manifest: data.manifest }) as WorkflowDefinition;
    definitions.set(definition, data);
    return definition;
  } catch (error) {
    if (error instanceof JawStackDefinitionError) throw error;
    return workflowDefinitionError("Invalid workflow declaration.");
  }
}
