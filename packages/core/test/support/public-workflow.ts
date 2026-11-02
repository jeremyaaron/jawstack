import { z } from "zod";
import {
  defineResource,
  defineCommand,
  defineState,
  defineWorker,
  field,
  defineWorkflow,
  defineAtomicRecord,
  createMemoryWorkflow,
  JawStackRuntimeError,
  type DefineWorkflowInput,
  type MemoryWorkflowOptions,
  type AuthContext,
  type WorkflowDefinition,
  type WorkflowDeliveryEvent,
} from "@jawstack/core";

export const testInstant = "2026-11-01T12:00:00.000Z";
export const workflowAuth = (): AuthContext => ({
  subject: "operator",
  roles: ["operator"],
  mode: "test",
  claims: { private: "operator-secret" },
});
export const workflowReceipt = defineAtomicRecord({
  name: "receipt",
  schema: z.strictObject({ resourceId: z.string(), version: z.number().int().positive() }),
  key: (value) => `${value.resourceId}#${value.version}`,
  owner: (value) => ({ resourceType: "document", resourceId: value.resourceId }),
});
const stateSchema = z.strictObject({ title: z.string(), done: z.boolean() });
const factPayloadSchema = z.strictObject({ docId: z.string(), title: z.string().trim() });
export function publicWorkflowInput(names = ["process"]): DefineWorkflowInput {
  return {
    name: "documents",
    source: "documents",
    commands: { idempotencyTtlSeconds: 604800 },
    records: [workflowReceipt],
    contribute: ({ commit }) => ({
      records: [
        workflowReceipt.create({
          resourceId: commit.resource.resourceId,
          version: commit.resource.next.version,
        }),
      ],
    }),
    resources: [
      defineResource({
        name: "document",
        title: "Document",
        state: defineState({ title: field.string(), done: field.boolean() }),
        commands: {
          create: defineCommand({
            title: "Create",
            create: true,
            roles: ["operator"],
            input: z.strictObject({ title: z.string().trim() }),
            emits: [{ eventType: "document.created", schemaVersion: 1 }],
            decide: ({ input, resourceId }) => ({
              nextState: { title: input.title, done: false },
              response: { id: resourceId },
              activity: [{ activityType: "created", title: "Created" }],
              events: [
                {
                  eventType: "document.created",
                  schemaVersion: 1,
                  payload: { docId: resourceId, title: input.title },
                },
              ],
            }),
          }),
          finish: defineCommand({
            title: "Finish",
            roles: ["worker"],
            input: z.strictObject({ expectedVersion: z.number().int().positive() }),
            emits: [{ eventType: "document.finished", schemaVersion: 1 }],
            decide: ({ input, previous, resourceId }) => {
              if (!previous || previous.version !== input.expectedVersion)
                throw new JawStackRuntimeError("resource.conflict", "Version changed.");
              const state = stateSchema.parse(previous.state);
              return {
                nextState: { ...state, done: true },
                response: { id: resourceId },
                activity: [{ activityType: "finished", title: "Finished" }],
                events: [
                  {
                    eventType: "document.finished",
                    schemaVersion: 1,
                    payload: { docId: resourceId, title: state.title },
                  },
                ],
              };
            },
          }),
        },
        workers: names.map((name) => defineWorker({ name, eventTypes: ["document.created"] })),
      }),
    ],
    events: ["document.created", "document.finished"].map((eventType) => ({
      eventType,
      schemaVersion: 1,
      schema: factPayloadSchema,
      validateIdentity: (event) =>
        event.resourceType === "document" && event.resourceId === event.payload.docId,
    })),
    consumers: Object.fromEntries(names.map((name) => [name, { recovery: "replay" as const }])),
    operations: { resourceType: "document", projection: "document.failures" },
  };
}
export function publicWorkflowFixture(
  options: {
    input?: DefineWorkflowInput;
    runtime?: Partial<MemoryWorkflowOptions>;
    beforeHandle?: () => void | Promise<void>;
    afterHandle?: () => void | Promise<void>;
  } = {},
) {
  let time = Date.parse(testInstant),
    id = 0;
  const input = options.input ?? publicWorkflowInput();
  const definition: WorkflowDefinition = defineWorkflow(input);
  const runtime = createMemoryWorkflow(definition, {
    clock: () => new Date(time),
    ids: { eventId: () => `event_${++id}`, activityId: () => `activity_${++id}` },
    authorizeOperations: (auth) => auth.subject === "operator" && auth.roles.includes("operator"),
    bind: (services) =>
      Object.fromEntries(
        definition.manifest.consumers.map((consumer) => [
          consumer.name,
          {
            handle: async (event: WorkflowDeliveryEvent) => {
              await options.beforeHandle?.();
              const row = await services.repository.getState("document", event.resourceId);
              if (!row) throw new JawStackRuntimeError("resource.not_found", "Missing document.");
              const state = stateSchema.parse(row.state),
                fact = factPayloadSchema.parse(event.payload);
              if (state.title !== fact.title)
                throw new JawStackRuntimeError(
                  "resource.conflict",
                  "Fact differs from frozen authority.",
                );
              if (state.done) return "ignored" as const;
              const result = await services.dispatch(
                {
                  resourceType: "document",
                  resourceId: event.resourceId,
                  commandName: "finish",
                  input: { expectedVersion: row.version },
                  idempotencyKey: `finish:${event.originalEventId}`,
                  requestContext: {},
                },
                { subject: "worker", roles: ["worker"], mode: "test", claims: {} },
              );
              if (!result.ok)
                throw new JawStackRuntimeError(result.error.code, result.error.message);
              await options.afterHandle?.();
            },
          },
        ]),
      ),
    ...options.runtime,
  });
  const create = (resourceId = "doc_1", title = "Draft") =>
    runtime.dispatch(
      {
        resourceType: "document",
        resourceId,
        commandName: "create",
        input: { title },
        idempotencyKey: `create:${resourceId}`,
        requestContext: { opaque: () => {} },
      },
      workflowAuth(),
    );
  return {
    runtime,
    definition,
    input,
    create,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
