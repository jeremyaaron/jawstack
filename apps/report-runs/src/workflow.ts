import { randomUUID } from "node:crypto";
import {
  createMemoryWorkflow,
  defineWorkflow,
  JawStackRuntimeError,
  type WorkflowRuntimeOptions,
  type WorkflowServices,
  type WorkflowDeliveryEvent,
} from "@jawstack/core";
import { createLocalWorkflow, type LocalWorkflowOptions } from "@jawstack/aws-runtime/local";
import {
  calculate,
  inputDigest,
  readReport,
  reportResource,
  requestedFact,
  completedFact,
  serializeResult,
  sha256,
  bytes,
  workerIdentity,
} from "./domain";

export const fixtures = ["requester_1", "requester_2", "operator_1"] as const;
export function fixtureAuth(id: string) {
  if (!fixtures.includes(id as (typeof fixtures)[number]))
    throw new JawStackRuntimeError("auth.forbidden", "Unknown report fixture identity.");
  return {
    subject: id,
    roles: [id === "operator_1" ? "operator" : "requester"],
    claims: {},
    mode: "dev" as const,
  };
}
export const isOperator = (auth: { subject: string; roles: readonly string[]; mode: string }) =>
  auth.subject === "operator_1" && auth.roles.includes("operator") && auth.mode === "dev";
export function reportDefinition(source = "report-runs") {
  return defineWorkflow({
    name: "report-runs",
    source,
    resources: [reportResource],
    commands: { idempotencyTtlSeconds: 604800 },
    events: [
      { eventType: "reportRun.requested", schemaVersion: 1, schema: requestedFact },
      { eventType: "reportRun.completed", schemaVersion: 1, schema: completedFact },
    ].map((event) => ({
      ...event,
      validateIdentity: (fact) =>
        fact.resourceType === "reportRun" && fact.resourceId === fact.payload.reportId,
    })),
    consumers: { buildInventory: { recovery: "replay" } },
    operations: { resourceType: "reportRun", projection: "reportRun.failures" },
    eventBytes: 2048,
  });
}
export type WorkerHooks = {
  before?(event: WorkflowDeliveryEvent): void | Promise<void>;
  afterComplete?(event: WorkflowDeliveryEvent): void | Promise<void>;
};
export function reportBindings(services: WorkflowServices, hooks: WorkerHooks = {}) {
  const authority = async (fact: unknown) => {
    const request = requestedFact.parse(fact);
    const row = readReport(
      await services.repository.getState("reportRun", request.reportId),
      request.reportId,
    );
    if (
      row.state.inputDigest !== request.inputDigest ||
      row.state.requestedAt !== request.requestedAt
    )
      throw new JawStackRuntimeError("command.rejected", "Fact differs from report authority.");
    return row;
  };
  return {
    buildInventory: {
      handle: async (event: WorkflowDeliveryEvent, { signal }: { signal: AbortSignal }) => {
        signal.throwIfAborted();
        await hooks.before?.(event);
        const row = await authority(event.payload);
        if (row.state.status === "completed") return "ignored" as const;
        const output = serializeResult(
          calculate(row.resourceId, row.state.requestedAt, row.state.input),
        );
        const result = await services.dispatch(
          {
            resourceType: "reportRun",
            resourceId: row.resourceId,
            commandName: "complete",
            input: {
              expectedVersion: row.version,
              reportId: row.resourceId,
              requestedAt: row.state.requestedAt,
              inputDigest: row.state.inputDigest,
              result: output.result,
              resultDigest: output.digest,
            },
            idempotencyKey:
              "complete:" + sha256(bytes([row.resourceId, inputDigest(row.state.input)])),
            requestId: event.eventId,
            correlationId: event.correlationId,
            requestContext: {},
          },
          workerIdentity,
        );
        if (!result.ok) {
          const latest = await authority(event.payload);
          if (latest.state.status !== "completed")
            throw new JawStackRuntimeError(result.error.code, result.error.message);
        }
        await hooks.afterComplete?.(event);
      },
      reconcileFailure: async ({ failure }: { failure: { original: { payload: unknown } } }) =>
        (await authority(failure.original.payload)).state.status === "completed"
          ? ("succeeded" as const)
          : ("notApplicable" as const),
      authorizeReplay: async ({ original }: { original: { payload: unknown } }) => {
        return (await authority(original.payload)).state.status === "requested";
      },
    },
  };
}
function callbacks(
  options: { clock?: () => Date; hooks?: WorkerHooks } = {},
): WorkflowRuntimeOptions {
  return {
    ids: { resourceId: () => randomUUID() },
    authorizeOperations: isOperator,
    ...(options.clock ? { clock: options.clock } : {}),
    bind: (services) => reportBindings(services, options.hooks),
  };
}
export function createMemoryReport(options: { clock?: () => Date; hooks?: WorkerHooks } = {}) {
  return createMemoryWorkflow(reportDefinition(), callbacks(options));
}
export function createLocalReport(
  options: Omit<LocalWorkflowOptions, keyof WorkflowRuntimeOptions> & {
    source: string;
    hooks?: WorkerHooks;
  },
) {
  const { source, hooks, ...local } = options;
  return createLocalWorkflow(reportDefinition(source), {
    ...local,
    ...callbacks({ ...(hooks ? { hooks } : {}) }),
  });
}
