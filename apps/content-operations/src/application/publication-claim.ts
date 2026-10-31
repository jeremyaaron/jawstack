import { z } from "zod";
import {
  contentStateSchema,
  idSchema,
  publicationClaimSchema,
  publicationGenerationSchema,
  versionSchema,
} from "../shared/contracts";
import type { CommandExecutionResult, CommandRequest, ResourceRepository } from "@jawstack/core";

const claimResponse = z.object({
  resourceId: idSchema,
  publicationId: idSchema,
  generation: publicationGenerationSchema,
  claim: publicationClaimSchema,
});
export async function validateClaimResponse(
  request: CommandRequest,
  result: CommandExecutionResult,
  repository: ResourceRepository | undefined,
  clock: () => Date,
): Promise<CommandExecutionResult> {
  if (
    !result.ok ||
    request.resourceType !== "contentItem" ||
    request.commandName !== "claimPublication" ||
    !repository
  )
    return result;
  try {
    const now = clock();
    const response = claimResponse.safeParse(result.data);
    const current = await repository.getState("contentItem", request.resourceId!);
    const parsed = contentStateSchema.safeParse(current?.state);
    if (
      !response.success ||
      !parsed.success ||
      current?.resourceType !== "contentItem" ||
      current.resourceId !== request.resourceId ||
      !versionSchema.safeParse(current.version).success ||
      parsed.data.contentId !== request.resourceId ||
      response.data.resourceId !== request.resourceId
    )
      return {
        ok: false,
        error: {
          code: "resource.invalid_state",
          message: "Publication claim response/state is invalid.",
        },
        meta: result.meta,
      };
    const publication = parsed.data.publication;
    const expected = response.data;
    if (
      parsed.data.status !== "publishing" ||
      publication?.generation !== expected.generation ||
      publication.intent.publicationId !== expected.publicationId ||
      publication.claim?.attemptId !== expected.claim.attemptId ||
      publication.claim.fencingToken !== expected.claim.fencingToken ||
      publication.claim.startedAt !== expected.claim.startedAt ||
      publication.claim.leaseUntil !== expected.claim.leaseUntil ||
      Date.parse(publication.claim.startedAt) > now.getTime() ||
      Date.parse(publication.claim.leaseUntil) <= now.getTime()
    )
      return {
        ok: false,
        error: {
          code: "resource.conflict",
          message: "Claim replay is stale; acquire a fresh attempt with a new key.",
        },
        meta: result.meta,
      };
    return result;
  } catch {
    return {
      ok: false,
      error: { code: "runtime.unavailable", message: "Publication claim verification failed." },
      meta: result.meta,
    };
  }
}
