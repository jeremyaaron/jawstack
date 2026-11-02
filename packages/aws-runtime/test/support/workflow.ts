import { z } from "zod";
import {
  createMemoryWorkflow,
  defineAtomicRecord,
  defineCommand,
  defineResource,
  defineState,
  defineWorker,
  defineWorkflow,
  field,
  JawStackRuntimeError,
  type AuthContext,
  type WorkflowRuntimeOptions,
  type DefineWorkflowInput,
  type CommandRequest,
} from "@jawstack/core";
import { createDynamoWorkflow, type DynamoDbClientLike } from "../../src/index";

export const initial = "2026-11-01T12:00:00.000Z";
export const auth = (): AuthContext => ({
  subject: "operator",
  roles: ["operator"],
  claims: {},
  mode: "test",
});
export const receipt = defineAtomicRecord({
  name: "receipt",
  schema: z.strictObject({ id: z.string(), version: z.number().int().positive() }),
  key: (value) => `${value.id}#${value.version}`,
  owner: (value) => ({ resourceType: "document", resourceId: value.id }),
});
export function fixture(
  backend: "memory" | "dynamo",
  options: {
    client?: DynamoDbClientLike;
    runtime?: Partial<WorkflowRuntimeOptions>;
    change?: (input: DefineWorkflowInput) => DefineWorkflowInput;
  } = {},
) {
  let time = Date.parse(initial),
    sequence = 0,
    decisions = 0;
  const input: DefineWorkflowInput = {
    name: "documents",
    source: "documents",
    commands: { idempotencyTtlSeconds: 604800 },
    records: [receipt],
    contribute: ({ commit }) => ({
      records: [
        receipt.create({ id: commit.resource.resourceId, version: commit.resource.next.version }),
      ],
    }),
    resources: [
      defineResource({
        name: "document",
        title: "Document",
        state: defineState({ title: field.string() }),
        commands: Object.fromEntries(
          ["create", "edit"].map((name) => [
            name,
            defineCommand({
              title: name,
              create: name === "create",
              roles: ["operator"],
              input: z.strictObject({
                title: z.string().trim(),
                expectedVersion: z.number().int().positive().optional(),
              }),
              emits: [{ eventType: "document.changed", schemaVersion: 1 }],
              decide: ({ input, previous, resourceId }) => {
                decisions++;
                if (previous && input.expectedVersion !== previous.version)
                  throw new JawStackRuntimeError("resource.conflict", "Stale version.");
                const version = (previous?.version ?? 0) + 1;
                const row = {
                  projectionName: "document.list",
                  itemId: resourceId,
                  sort: `v${version}`,
                  data: { title: input.title },
                };
                return {
                  nextState: { title: input.title },
                  response: { id: resourceId, title: input.title },
                  activity: [{ activityType: "changed", title: "Changed" }],
                  events: [
                    {
                      eventType: "document.changed",
                      schemaVersion: 1,
                      payload: { id: resourceId, title: input.title },
                    },
                  ],
                  projections: [
                    ...(previous ? [{ ...row, sort: `v${version - 1}`, delete: true }] : []),
                    row,
                  ],
                };
              },
            }),
          ]),
        ),
        workers: [defineWorker({ name: "process", eventTypes: ["document.changed"] })],
      }),
    ],
    events: [
      {
        eventType: "document.changed",
        schemaVersion: 1,
        schema: z.strictObject({ id: z.string(), title: z.string() }),
        validateIdentity: (event) =>
          event.resourceType === "document" && event.resourceId === event.payload.id,
      },
    ],
    consumers: { process: { recovery: "replay" } },
    operations: { resourceType: "document", projection: "document.failures" },
  };
  const definition = defineWorkflow(options.change?.(input) ?? input);
  const runtimeOptions: WorkflowRuntimeOptions = {
    clock: () => new Date(time),
    ids: { eventId: () => `event_${++sequence}`, activityId: () => `activity_${++sequence}` },
    authorizeOperations: (identity) =>
      identity.subject === "operator" && identity.roles.includes("operator"),
    bind: () => ({ process: { handle: () => {} } }),
    ...options.runtime,
  };
  const memory =
    backend === "memory" ? createMemoryWorkflow(definition, runtimeOptions) : undefined;
  const runtime =
    memory ??
    createDynamoWorkflow(definition, {
      ...runtimeOptions,
      client: options.client!,
      tableName: "workflow-test",
    });
  const request = (
    key = "key",
    title = "Draft",
    id = "doc_1",
    name = "create",
    expectedVersion = 1,
  ): CommandRequest => ({
    resourceType: "document",
    resourceId: id,
    commandName: name,
    input: { title, ...(name === "edit" ? { expectedVersion } : {}) },
    idempotencyKey: key,
    requestContext: {},
  });
  const original = {
    envelopeVersion: 1 as const,
    eventId: "original",
    eventType: "document.changed",
    schemaVersion: 1,
    source: "documents",
    resourceType: "document",
    resourceId: "doc_1",
    correlationId: "correlation",
    occurredAt: initial,
    payload: { id: "doc_1", title: "Draft" },
  };
  return {
    runtime,
    memory,
    definition,
    original,
    request,
    run: (key = "key", title = "Draft", id = "doc_1", identity = auth()) =>
      runtime.dispatch(request(key, title, id), identity),
    advance: (ms: number) => {
      time += ms;
    },
    decisions: () => decisions,
  };
}
