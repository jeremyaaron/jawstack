import { isDeepStrictEqual } from "node:util";
import {
  createWorkflowFailureService,
  JawStackRuntimeError,
  type AuthContext,
  type ResourceRepository,
  type WorkflowFailureRecord,
  type WorkflowReadonly,
} from "@jawstack/core";
import { contentStateSchema, publicationRequestSchema } from "../shared/contracts";
import { editorIds } from "../shared/identities";
import { failureCollectorIdentity } from "../domain/publication-commands";
import { createContentStorageSpec } from "./workflow";
import type { FailureStore } from "./failure-records";
import type { createContentDispatch } from "./dispatch";

export type RecoveryFaultPoint = "afterRecord" | "afterReconcile" | "afterReplayCommit";
export const authorizeContentOperations = (auth: Readonly<AuthContext>) =>
  editorIds.includes(auth.subject as (typeof editorIds)[number]) &&
  auth.roles.includes("editor") &&
  ["dev", "test"].includes(auth.mode);

export function createPublicationReconciler(options: {
  repository: ResourceRepository;
  dispatch: ReturnType<typeof createContentDispatch>;
  clock?: () => Date;
}) {
  const clock = options.clock ?? (() => new Date());
  const reconcile = async (record: WorkflowReadonly<WorkflowFailureRecord>) => {
    if (record.consumer !== "publishContent") return "notApplicable" as const;
    const request = publicationRequestSchema.parse(record.original.payload);
    for (let retry = 0; retry < 3; retry++) {
      const row = await options.repository.getState("contentItem", request.contentId);
      if (!row) return "superseded" as const;
      const state = contentStateSchema.parse(row.state);
      const publication = state.publication;
      if (
        row.resourceType !== "contentItem" ||
        row.resourceId !== request.contentId ||
        state.contentId !== request.contentId
      )
        throw new JawStackRuntimeError(
          "resource.invalid_state",
          "Invalid publication reconciliation authority.",
        );
      if (
        !publication ||
        publication.intent.publicationId !== request.publicationId ||
        publication.generation !== request.generation
      )
        return "superseded" as const;
      if (!isDeepStrictEqual(publication.intent, request.intent))
        throw new JawStackRuntimeError(
          "command.validation",
          "Failed publication fact differs from frozen authority.",
        );
      if (publication.phase === "succeeded") return "succeeded" as const;
      if (publication.phase === "failed") return "failed" as const;
      if (publication.phase === "stalled")
        return publication.deliveryFailure!.failureId === record.id
          ? ("stalled" as const)
          : ("superseded" as const);
      if (publication.claim) {
        if (publication.lastAttempt!.sourceEventId !== record.original.eventId)
          return "superseded" as const;
        if (Date.parse(publication.claim.leaseUntil) > clock().getTime())
          throw new JawStackRuntimeError(
            "resource.conflict",
            "Failure collection awaits the live publication claim.",
          );
      }
      const result = await options.dispatch(
        {
          resourceType: "contentItem",
          resourceId: request.contentId,
          commandName: "reconcilePublicationFailure",
          input: {
            expectedVersion: row.version,
            publicationId: request.publicationId,
            generation: request.generation,
            sourceEventId: record.original.eventId,
            failureId: record.id,
          },
          idempotencyKey: `reconcile:${record.id}:${row.version}`,
          requestId: record.original.eventId,
          correlationId: record.original.correlationId,
          requestContext: {},
        },
        {
          subject: failureCollectorIdentity.subject,
          roles: [failureCollectorIdentity.role],
          mode: "dev",
          claims: {},
        },
      );
      if (result.ok) return "stalled" as const;
      if (result.error.code !== "resource.conflict")
        throw new JawStackRuntimeError(result.error.code, result.error.message);
    }
    throw new JawStackRuntimeError(
      "resource.conflict",
      "Publication reconciliation retry budget exhausted.",
    );
  };

  return reconcile;
}
export function createFailureService(options: {
  store: FailureStore;
  repository: ResourceRepository;
  dispatch: ReturnType<typeof createContentDispatch>;
  source: string;
  clock?: () => Date;
  fault?: (point: RecoveryFaultPoint) => void | Promise<void>;
}) {
  const reconcile = createPublicationReconciler(options);
  const shared = createWorkflowFailureService({
    protocol: createContentStorageSpec(options.source).protocol,
    store: options.store,
    authorizeOperations: authorizeContentOperations,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.fault ? { fault: options.fault } : {}),
    hooks: {
      publishContent: {
        reconcileFailure: ({ failure }) => reconcile(failure),
      },
    },
  });
  return {
    ...shared,
    // Preserve the HTTP projection-row DTO; authorization and cursors remain shared.
    inspect: async (...args: Parameters<typeof shared.inspect>) => {
      const result = await shared.inspect(...args);
      if (!("items" in result)) return result;
      return {
        ...result,
        items: result.items.map((data) => ({
          projectionName: "contentItem.failures",
          itemId: data.id,
          sort: `${data.firstCollectedAt}#${data.id}`,
          data,
        })),
      };
    },
  };
}
