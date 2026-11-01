import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  JawStackDefinitionError,
  type ActivityRecord,
  type CommandCommitInput,
  type IdempotencyRecord,
  type JawStackEvent,
  type ProjectionWrite,
  type ResourceState,
} from "../index";
import {
  registerRecords,
  resolveRecord,
  type AtomicRecordCreate,
  type AtomicRecordDefinition,
  type AtomicRecordOwner,
} from "./records";
import { workflowRecordKeys, type WorkflowCommandScope, type WorkflowRecordKey } from "./keys";
import {
  component,
  freeze,
  instant,
  jsonCopy,
  plainObject,
  reject,
  synchronous,
  workflowCommitLimits,
  type WorkflowReadonly,
} from "./validation";

export type WorkflowCommandInvocation = Readonly<{ scope: WorkflowCommandScope; now: string }>;
type Condition =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "version"; expectedVersion: number }>;
type BaseWrite = Readonly<{ key: WorkflowRecordKey }>;
export type WorkflowCommitWrite = BaseWrite &
  (
    | Readonly<{ kind: "resource"; condition: Condition; value: WorkflowReadonly<ResourceState> }>
    | Readonly<{
        kind: "activity";
        condition: Readonly<{ kind: "absent" }>;
        value: WorkflowReadonly<ActivityRecord>;
      }>
    | Readonly<{
        kind: "outbox";
        condition: Readonly<{ kind: "absent" }>;
        value: WorkflowReadonly<JawStackEvent>;
      }>
    | Readonly<{ kind: "projection"; value: WorkflowReadonly<ProjectionWrite> }>
    | Readonly<{ kind: "projectionDelete" }>
    | Readonly<{
        kind: "idempotency";
        condition: Readonly<{ kind: "absentOrExpired"; nowSeconds: number }>;
        value: WorkflowReadonly<
          IdempotencyRecord & WorkflowCommandScope & { createdAt: string; expiresAt: number }
        >;
      }>
    | Readonly<{
        kind: "record";
        condition: Readonly<{ kind: "absent" }>;
        collection: string;
        owner: AtomicRecordOwner;
        value: unknown;
      }>
  );
declare const planBrand: unique symbol;
export type WorkflowCommitPlan = Readonly<{
  [planBrand]: true;
  schemaVersion: 1;
  workflowName: string;
  scope: WorkflowCommandScope;
  now: string;
  actions: readonly WorkflowCommitWrite[];
}>;
export type WorkflowCommitContributor = (
  input: Readonly<{
    invocation: WorkflowReadonly<WorkflowCommandInvocation>;
    commit: WorkflowReadonly<CommandCommitInput>;
  }>,
) => Readonly<{
  records?: readonly AtomicRecordCreate[];
  projections?: readonly ProjectionWrite[];
}>;
export interface WorkflowCommitPlanner {
  readonly workflowName: string;
  plan(invocation: WorkflowCommandInvocation, commit: CommandCommitInput): WorkflowCommitPlan;
  validate(plan: unknown): WorkflowCommitPlan;
}
// Implementations must call their bound planner.validate before reads/writes with effects.
export interface WorkflowCommitStore {
  commit(plan: WorkflowCommitPlan): Promise<void>;
}

const identity = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const text = z.string();
const date = text.refine((value) => {
  try {
    instant(value);
    return true;
  } catch {
    return false;
  }
});
const version = z.number().int().positive().safe();
const actor = z.strictObject({ subject: identity, displayName: text.optional() });
const stateSchema = z.strictObject({
  resourceType: identity,
  resourceId: identity,
  version,
  state: z.unknown(),
  createdAt: date,
  updatedAt: date,
  createdBy: identity,
  updatedBy: identity,
});
const activitySchema = z.strictObject({
  activityId: identity,
  resourceType: identity,
  resourceId: identity,
  activityType: identity,
  title: text,
  summary: text.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  actor: actor.optional(),
  correlationId: identity,
  causationId: identity.optional(),
  occurredAt: date,
});
const eventSchema = z.strictObject({
  envelopeVersion: z.literal(1),
  eventId: identity,
  eventType: text.regex(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/),
  schemaVersion: version,
  source: text.min(1).max(200),
  resourceType: identity,
  resourceId: identity,
  actor: actor.optional(),
  correlationId: identity,
  causationId: identity.optional(),
  occurredAt: date,
  payload: z.unknown(),
});
const projectionSchema = z.strictObject({
  projectionName: identity,
  itemId: identity,
  sort: text.min(1),
  data: z.record(z.string(), z.unknown()),
  delete: z.boolean().optional(),
});
const successSchema = z.strictObject({
  ok: z.literal(true),
  data: z.unknown(),
  meta: z.strictObject({ requestId: identity, correlationId: identity }),
});
const commitSchema = z.strictObject({
  resource: z.strictObject({
    resourceType: identity,
    resourceId: identity,
    expectedVersion: version.optional(),
    create: z.boolean(),
    next: stateSchema,
  }),
  activity: z.array(activitySchema),
  outbox: z.array(eventSchema),
  projections: z.array(projectionSchema),
  response: z.unknown(),
  idempotency: z.strictObject({ key: identity, fingerprint: text.min(1), response: successSchema }),
});
const invocationSchema = z.strictObject({
  scope: z.strictObject({ resourceType: identity, commandName: identity, subject: identity }),
  now: date,
});

export function createWorkflowCommitPlanner(options: {
  workflowName: string;
  source: string;
  idempotencyTtlSeconds: number;
  maxActions?: number;
  records?: readonly AtomicRecordDefinition[];
  contribute?: WorkflowCommitContributor;
}): WorkflowCommitPlanner {
  const maximum = options.maxActions ?? workflowCommitLimits.actions;
  const ttl = options.idempotencyTtlSeconds;
  const workflowName = options.workflowName,
    source = options.source,
    contribute = options.contribute;
  try {
    component(workflowName);
  } catch {
    throw new JawStackDefinitionError("workflow.plan", "Invalid workflow name.");
  }
  if (
    !Number.isInteger(maximum) ||
    maximum < 1 ||
    maximum > workflowCommitLimits.actions ||
    !Number.isSafeInteger(ttl) ||
    ttl < 1 ||
    ttl > workflowCommitLimits.idempotencyTtlSeconds ||
    typeof source !== "string" ||
    !source.trim() ||
    source.length > 200 ||
    (contribute !== undefined && typeof contribute !== "function") ||
    (options.records !== undefined && !Array.isArray(options.records))
  )
    throw new JawStackDefinitionError("workflow.plan", "Invalid workflow commit policy.");
  const registry = registerRecords(options.records ?? []);
  const owned = new WeakSet<object>();
  return Object.freeze({
    workflowName,
    validate(value: unknown): WorkflowCommitPlan {
      if (typeof value !== "object" || value === null || !owned.has(value))
        reject("Commit plan was not produced by this workflow planner.");
      return value as WorkflowCommitPlan;
    },
    plan(
      invocationInput: WorkflowCommandInvocation,
      commitInput: CommandCommitInput,
    ): WorkflowCommitPlan {
      const capturedInvocation = jsonCopy(invocationInput),
        capturedCommit = jsonCopy(commitInput);
      const invocationResult = invocationSchema.safeParse(capturedInvocation);
      const commitResult = commitSchema.safeParse(capturedCommit);
      if (!invocationResult.success || !commitResult.success)
        reject("Invalid scoped workflow commit.");
      // Validate without reordering stored envelope properties or changing core fingerprints.
      // The JSON check rejects present-undefined fields before narrowing optional TS properties.
      const invocation = freeze(capturedInvocation);
      const commit = freeze(
        capturedCommit as CommandCommitInput & { idempotency: IdempotencyRecord },
      );
      const { scope, now } = invocation;
      const { resource, idempotency } = commit;
      const next = resource.next;
      const meta = idempotency.response.meta;
      if (
        resource.resourceType !== scope.resourceType ||
        next.resourceType !== scope.resourceType ||
        next.resourceId !== resource.resourceId ||
        next.updatedBy !== scope.subject ||
        next.updatedAt !== now ||
        Date.parse(next.createdAt) > Date.parse(now) ||
        (resource.create
          ? resource.expectedVersion !== undefined ||
            next.version !== 1 ||
            next.createdAt !== now ||
            next.createdBy !== scope.subject
          : resource.expectedVersion === undefined ||
            next.version !== resource.expectedVersion + 1) ||
        !isDeepStrictEqual(commit.response, idempotency.response.data)
      )
        reject("Commit does not match its resource, actor, version, time or response.");
      for (const row of [...commit.activity, ...commit.outbox]) {
        if (
          row.resourceType !== resource.resourceType ||
          row.resourceId !== resource.resourceId ||
          row.occurredAt !== now ||
          row.correlationId !== meta.correlationId ||
          (row.causationId !== undefined && row.causationId !== meta.requestId) ||
          (row.actor !== undefined && row.actor.subject !== scope.subject) ||
          ("source" in row &&
            (row.source !== source || (plainObject(row.payload) && "delivery" in row.payload)))
        )
          reject("Activity/outbox identity differs from the command commit.");
      }
      const contributions = synchronous(contribute ? contribute({ invocation, commit }) : {});
      if (
        !plainObject(contributions) ||
        Object.keys(contributions).some((key) => !["records", "projections"].includes(key)) ||
        Reflect.ownKeys(contributions).some(
          (key) =>
            typeof key !== "string" ||
            !("value" in Object.getOwnPropertyDescriptor(contributions, key)!),
        ) ||
        (contributions.records !== undefined && !Array.isArray(contributions.records)) ||
        (contributions.projections !== undefined && !Array.isArray(contributions.projections))
      )
        reject("Contributors must return synchronous records/projections only.");
      const actions: WorkflowCommitWrite[] = [];
      const indexes = new Map<string, number>();
      const add = (action: WorkflowCommitWrite) => {
        jsonCopy(
          action,
          action.kind === "record"
            ? workflowCommitLimits.auxiliaryBytes
            : workflowCommitLimits.recordBytes,
        );
        const physical = JSON.stringify([action.key.partition, action.key.sort]);
        const previousIndex = indexes.get(physical);
        if (previousIndex !== undefined) {
          const previous = actions[previousIndex]!;
          const projection = (a: WorkflowCommitWrite) =>
            ["projection", "projectionDelete"].includes(a.kind);
          if (!projection(previous) || !projection(action))
            reject("Duplicate physical workflow action.");
          if (
            previous.kind === "projection" &&
            action.kind === "projection" &&
            !isDeepStrictEqual(previous, action)
          )
            reject("Conflicting workflow projection puts.");
          if (previous.kind === "projectionDelete") actions[previousIndex] = action;
          return;
        }
        indexes.set(physical, actions.length);
        actions.push(action);
        if (actions.length > maximum) reject("Workflow transaction exceeds its action budget.");
      };
      add({
        kind: "resource",
        key: workflowRecordKeys.resource(resource.resourceType, resource.resourceId),
        condition: resource.create
          ? { kind: "absent" }
          : { kind: "version", expectedVersion: resource.expectedVersion! },
        value: next,
      });
      for (const value of commit.activity)
        add({
          kind: "activity",
          key: workflowRecordKeys.activity(value),
          condition: { kind: "absent" },
          value,
        });
      for (const value of commit.outbox)
        add({
          kind: "outbox",
          key: workflowRecordKeys.outbox(value.eventId),
          condition: { kind: "absent" },
          value,
        });
      for (const input of [...commit.projections, ...(contributions.projections ?? [])]) {
        const parsed = projectionSchema.safeParse(jsonCopy(input));
        if (!parsed.success) reject("Invalid workflow projection contribution.");
        const key = workflowRecordKeys.projection(resource.resourceType, parsed.data);
        if (parsed.data.delete) add({ kind: "projectionDelete", key });
        else
          add({
            kind: "projection",
            key,
            value: {
              projectionName: parsed.data.projectionName,
              itemId: parsed.data.itemId,
              sort: key.sort,
              data: parsed.data.data,
            },
          });
      }
      const nowSeconds = Math.floor(Date.parse(now) / 1000);
      add({
        kind: "idempotency",
        key: workflowRecordKeys.idempotency(scope, idempotency.key),
        condition: { kind: "absentOrExpired", nowSeconds },
        value: { ...idempotency, ...scope, createdAt: now, expiresAt: nowSeconds + ttl },
      });
      for (const create of contributions.records ?? []) {
        const record = resolveRecord(create, registry, {
          resourceType: resource.resourceType,
          resourceId: resource.resourceId,
        });
        add({
          kind: "record",
          key: workflowRecordKeys.record(record.collection, record.logicalKey),
          condition: { kind: "absent" },
          collection: record.collection,
          owner: record.owner,
          value: record.value,
        });
      }
      const plan = freeze(
        jsonCopy({ schemaVersion: 1, workflowName, scope, now, actions }),
      ) as WorkflowCommitPlan;
      owned.add(plan);
      return plan;
    },
  });
}
