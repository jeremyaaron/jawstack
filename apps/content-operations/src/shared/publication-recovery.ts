import type { PublicationState } from "./contracts";
import { limits } from "./validation";

type RecoveryState = Pick<PublicationState, "phase" | "generation" | "attemptsInGeneration"> & {
  claim: { leaseUntil: string } | null;
  lastAttempt: { status: string; generation: number } | null;
};
export function publicationRecovery(state: RecoveryState, now: number) {
  const liveLease = !!state.claim && Date.parse(state.claim.leaseUntil) > now;
  const expiredLease = !!state.claim && !liveLease;
  const hasRecoverableWork =
    state.phase === "failed" ||
    state.phase === "stalled" ||
    (state.lastAttempt?.status === "failed" && state.lastAttempt.generation === state.generation) ||
    !!state.claim;
  const remainingGenerations = Math.max(0, limits.publicationGenerations - state.generation);
  return {
    liveLease,
    expiredLease,
    hasRecoverableWork,
    remainingGenerations,
    remainingAttempts: Math.max(0, limits.publicationAttempts - state.attemptsInGeneration),
    status: expiredLease ? ("stalled" as const) : state.phase,
    eligible: !liveLease && hasRecoverableWork && remainingGenerations > 0,
  };
}
