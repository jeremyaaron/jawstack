import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { JawStackRuntimeError, type ResourceRepository } from "@jawstack/core";
import {
  contentStateSchema,
  publicationClaimSchema,
  publicationRequestSchema,
  type PublicationState,
} from "../shared/contracts";
import { instantSchema, versionSchema } from "../shared/validation";
import type { ContentEvent } from "../shared/events";
import { publisherIdentity } from "../domain/publication-commands";
import {
  PublicationExecutionError,
  serializePublication,
  type PublicationObjectStore,
} from "./publication-artifact";
import type { createContentDispatch } from "./dispatch";

export type PublicationFaultPoint =
  | "afterClaim"
  | "afterObjectWrite"
  | "beforeCompletion"
  | "afterCompletion";
export class SimulatedPublicationCrash extends JawStackRuntimeError {
  constructor() {
    super("runtime.unavailable", "Injected publication process interruption.");
  }
}
export function createPublisher(options: {
  repository: ResourceRepository;
  dispatch: ReturnType<typeof createContentDispatch>;
  objects: PublicationObjectStore;
  clock?: () => Date;
  newAttemptId?: () => string;
  fault?: (point: PublicationFaultPoint) => void | Promise<void>;
}) {
  const clock = options.clock ?? (() => new Date());
  return async (event: ContentEvent) => {
    if (
      !["contentItem.publicationRequested", "contentItem.publicationRetried"].includes(
        event.eventType,
      )
    )
      throw new JawStackRuntimeError(
        "command.rejected",
        "Publisher is not subscribed to this fact.",
      );
    const request = publicationRequestSchema.parse(event.payload);
    const artifact = serializePublication(request.intent);
    const load = async () => {
      const row = await options.repository.getState("contentItem", request.contentId);
      const parsed = contentStateSchema.safeParse(row?.state);
      if (
        !row ||
        !parsed.success ||
        row.resourceType !== "contentItem" ||
        row.resourceId !== request.contentId ||
        parsed.data.contentId !== request.contentId ||
        !versionSchema.safeParse(row.version).success ||
        !instantSchema.safeParse(row.createdAt).success ||
        !instantSchema.safeParse(row.updatedAt).success
      )
        throw new JawStackRuntimeError(
          "resource.invalid_state",
          "Authoritative publication state is invalid.",
        );
      return { ...row, state: parsed.data };
    };
    const classify = (publication: PublicationState | null) => {
      if (
        !publication ||
        publication.intent.publicationId !== request.publicationId ||
        publication.generation !== request.generation
      )
        return "obsolete";
      if (!isDeepStrictEqual(publication.intent, request.intent))
        throw new JawStackRuntimeError(
          "command.validation",
          "Publication event does not match the frozen intent.",
        );
      if (publication.phase === "succeeded") {
        if (
          !publication.artifact ||
          publication.artifact.sha256 !== artifact.reference.sha256 ||
          publication.artifact.size !== artifact.reference.size ||
          publication.artifact.objectKey !== artifact.reference.objectKey
        )
          throw new JawStackRuntimeError(
            "resource.invalid_state",
            "Completed publication metadata differs from its intent.",
          );
        return "complete";
      }
      return "active";
    };
    const attemptId = (options.newAttemptId ?? randomUUID)();
    const key = (action: string) =>
      `publication:${action}:${createHash("sha256")
        .update(
          JSON.stringify([request.contentId, request.publicationId, request.generation, attemptId]),
        )
        .digest("hex")}`;
    const dispatch = (
      commandName: "claimPublication" | "completePublication" | "failPublication",
      input: Record<string, unknown>,
    ) =>
      options.dispatch(
        {
          resourceType: "contentItem",
          resourceId: request.contentId,
          commandName,
          input,
          requestId: event.eventId,
          correlationId: event.correlationId,
          idempotencyKey: key(commandName),
          requestContext: {},
        },
        {
          subject: publisherIdentity.subject,
          roles: [publisherIdentity.role],
          mode: "dev",
          claims: {},
        },
      );
    let claim: ReturnType<typeof publicationClaimSchema.parse> | undefined;
    for (let retry = 0; retry < 3; retry++) {
      const row = await load();
      const publication = row.state.publication;
      const state = classify(publication);
      if (state === "obsolete") return "ignored" as const;
      if (state === "complete") return "alreadyPublished" as const;
      if (publication!.phase === "failed")
        throw new JawStackRuntimeError(
          "command.rejected",
          "Publication cycle has failed; explicit recovery is required.",
        );
      if (publication!.claim && Date.parse(publication!.claim.leaseUntil) > clock().getTime())
        throw new JawStackRuntimeError(
          "resource.conflict",
          "Another publication claim is in progress.",
        );
      const result = await dispatch("claimPublication", {
        expectedVersion: row.version,
        publicationId: request.publicationId,
        generation: request.generation,
        attemptId,
      });
      if (result.ok) {
        claim = publicationClaimSchema.parse((result.data as { claim?: unknown }).claim);
        break;
      }
      if (result.error.code !== "resource.conflict")
        throw new JawStackRuntimeError(result.error.code, result.error.message);
    }
    if (!claim)
      throw new JawStackRuntimeError(
        "resource.conflict",
        "Publication claim retry budget exhausted.",
      );
    const owned = (publication: PublicationState | null) =>
      publication?.intent.publicationId === request.publicationId &&
      publication.generation === request.generation &&
      publication.phase === "running" &&
      publication.claim?.attemptId === claim!.attemptId &&
      publication.claim.fencingToken === claim!.fencingToken &&
      Date.parse(publication.claim.startedAt) <= clock().getTime() &&
      Date.parse(publication.claim.leaseUntil) > clock().getTime();
    const fence = (version: number) => ({
      expectedVersion: version,
      publicationId: request.publicationId,
      generation: request.generation,
      attemptId: claim!.attemptId,
      fencingToken: claim!.fencingToken,
    });
    try {
      await options.fault?.("afterClaim");
      const beforeWrite = await load();
      if (!owned(beforeWrite.state.publication))
        throw new JawStackRuntimeError(
          "resource.conflict",
          "Publication claim changed before object creation.",
        );
      const stored = await options.objects.createPublication(request.intent);
      if (!isDeepStrictEqual(stored, artifact.reference))
        throw new PublicationExecutionError("artifact.mismatch");
      await options.fault?.("afterObjectWrite");
      for (let retry = 0; retry < 3; retry++) {
        const row = await load();
        const state = classify(row.state.publication);
        if (state === "obsolete") return "ignored" as const;
        if (state === "complete") return "alreadyPublished" as const;
        if (!owned(row.state.publication))
          throw new JawStackRuntimeError(
            "resource.conflict",
            "Publication claim changed before completion.",
          );
        await options.fault?.("beforeCompletion");
        const result = await dispatch("completePublication", {
          ...fence(row.version),
          artifact: stored,
        });
        if (result.ok) {
          await options.fault?.("afterCompletion");
          return "published" as const;
        }
        if (result.error.code !== "resource.conflict")
          throw new JawStackRuntimeError(result.error.code, result.error.message);
      }
      throw new JawStackRuntimeError(
        "resource.conflict",
        "Publication completion retry budget exhausted.",
      );
    } catch (error) {
      if (error instanceof SimulatedPublicationCrash) throw error;
      const latest = await load();
      const state = classify(latest.state.publication);
      if (state === "obsolete") return "ignored" as const;
      if (state === "complete") return "alreadyPublished" as const;
      if (
        owned(latest.state.publication) &&
        !(
          error instanceof JawStackRuntimeError &&
          error.code === "resource.conflict" &&
          !(error instanceof PublicationExecutionError)
        )
      ) {
        const failureCode =
          error instanceof PublicationExecutionError ? error.failureCode : "execution.interrupted";
        for (let retry = 0; retry < 3; retry++) {
          const row = await load();
          if (!owned(row.state.publication)) break;
          const result = await dispatch("failPublication", { ...fence(row.version), failureCode });
          if (result.ok || result.error.code !== "resource.conflict") break;
        }
      }
      if (error instanceof JawStackRuntimeError) throw error;
      throw new JawStackRuntimeError(
        "runtime.unavailable",
        "Publication delivery interrupted; retry or recover.",
      );
    }
  };
}
