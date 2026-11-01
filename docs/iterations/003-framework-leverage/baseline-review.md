# Baseline Exercise Review

Status: baseline A/B observations reviewed November 1, 2026; the baseline prerequisite
for Phase 1 was cleared with the timing limitations below before extraction. Phase 1
subsequently completed; see [its evidence](phase-1-evidence.md).
This is not iteration acceptance, post-extraction evidence or a productivity claim.

The user confirmed **GPT-6.1 Sol / High** for both baseline agents and reports the same
selection for this coordinator chat. That agrees with both session records. It is a
user-reported visible selection, not independently observed hidden model telemetry.
Client version and token usage remain unavailable. Retain that distinction for post runs.

## Observed Results

| Observation                              | Task A: approval receipt                    | Task B: publication receipt                       |
| ---------------------------------------- | ------------------------------------------- | ------------------------------------------------- |
| Recorded interval                        | 21:05:49-21:09:10 UTC                       | 21:06:35-21:12:25 UTC                             |
| Reported timed elapsed, no install waits | 3 min 21 sec                                | 5 min 50 sec                                      |
| Neutral acceptance                       | 4/4 passed                                  | 4/4 passed                                        |
| App suite                                | 512 tests / 36 files passed                 | 518 tests / 37 files passed                       |
| Typecheck/lint                           | Passed after one adapter correction         | Passed after three recorded correction rounds     |
| Changed files                            | 3: two runtime, one test adapter            | 15: ten runtime, five test/composition files      |
| Existing runtime surfaces modified       | One app persistence planner/record registry | Seven app registration/validation/worker surfaces |
| Framework-package edits                  | None                                        | None                                              |

Both attempts used the same Phase 0 checkout commit
`3e11f152113cafe5411dbe5a2d112821047b7538`, frozen input packet, Node 24.16.0 and
pnpm 10.21.0. Their sources and raw records remain isolated in the prepared worktrees;
neither benchmark feature was copied into the main app. The frozen 1,589-token-line
retirement denominator, task specifications and tests have not changed.

[Sanitized machine-readable observations](leverage/baseline-results.json) retain the
session/patch hashes, token-line observations and explicit limitations. Full source
patches/logs/session records remain ignored in the corresponding worktree's `raw/`
directory; they are not copied into public documentation or post-task handoffs.

## Functional and Evidence Review

Reviewed both implementations and test adapters, not just their reported outcomes:

- A derives a typed receipt from actual committed approval authority and extends the
  existing app plan. Both adapters reuse their existing create-only auxiliary conditions
  and atomic commit. The test adapter runs ordinary create/submit/approve and snapshots
  real stores; it does not synthesize a receipt or discard rollback categories.
- B registers the real internal resource/consumer in ordinary memory/AWS composition.
  It uses an ordinary command, permanent business identity and current failure/replay
  services. The test adapter observes actual publication and recovery outbox facts,
  uses the production SQS wrapper with narrow marker doubles, and clears transport
  markers without deleting business state. Six added focused tests cover internal-only
  ingress, identity conflicts, concurrency and normal memory-pump collection/recovery.
- B's existing test edits update exact resource/function/queue/mapping counts for the new
  consumer. Per-worker transport/grant assertions remain; no acceptance test was relaxed.
- All frozen input hashes match in both worktrees. Saved patch hashes and every recorded
  changed-source hash match retained files. Reverse patch checks passed without applying
  or reverting anything. HEADs remain at Phase 0, staged diffs are empty, and public
  framework packages are unchanged. Agent records report fresh contexts and no opposite
  worktree inspection; private client history was not independently audited.

Independent coordinator reruns, after the recorded sessions, passed **both** neutral
four-case suites, **both** app suites (512/518), typecheck, lint and tracked whitespace
checks. These reruns are validation, not extra time retroactively assigned to an attempt.
They used no Docker, real AWS, browser or full-release gate. Local logs are under
`/tmp/jawstack-coordinator-baseline-{a,b}-{acceptance,app-tests,typecheck,lint}.log`.

Failed development checks remain in the raw records. A corrected one adapter counting
type error. B corrected resource metadata versus Zod schema confusion, an unsupported
numeric metadata kind, adapter typing, composition expectations and a focused test's
artifact type. Those corrections are part of the observation, not evidence to erase.

## Timing Qualification

The attempts **overlapped for 155 seconds**: 21:06:35 through 21:09:10 UTC. The handoff
requested sequential runs, so shared-machine contention is a protocol deviation and
timing confounder. Preserve it; do not subtract it as an install wait, normalize it away
or repeat attempts to select favorable results. Run future sessions sequentially.

The intervals also start after initial packet reading and settings agreement, rather
than being a complete instrumented client session. Dependencies and preflight were
prepared outside both timers. There are no separately timed domain/integration/test-
adapter categories, exact client version or actual token telemetry. The recorded elapsed
values are therefore descriptive only, not a controlled speed baseline or total effort.

These limitations do not invalidate reproducible functional tests or reviewable generic
integration changes. Accept the observations for those comparisons, not a timing-based
speedup claim. Post tests must still be equivalent and require no framework-internal
edits/reimplemented plumbing. The final leverage decision remains subject to the PRD;
no criterion or frozen fixture is waived by acknowledging these limitations.

## What This Establishes

A is already a small integration on the existing app foundation: one existing planner
changed (12 physical lines added, two removed) and one domain helper was added. Do not
portray the baseline as requiring a new transaction engine or assume extraction will
produce a large time saving. The framework opportunity is a supported typed extension
point and shared invariants, not an otherwise impossible receipt capability.

B exposes more integration surface: seven existing runtime files gained consumer/resource
registration, routing, enum/schema and recovery references, in addition to its domain
resource/schema/handler. Three composition-test files also needed updates. This gives
the single-definition/binding design a concrete target for reducing scattered wiring.
It does not make business identity comparison or domain schema validation generic code
that should disappear from the application.

Whole changed-runtime token-line net growth is 58 for A and 199 for B, including domain
code/configuration. These are **not** generic changed-line churn or the 50% protocol
retirement metric. The adapters themselves are 158/235 physical lines and are test
overhead, excluded from the runtime metric but disclosed as real exercise effort.

The baseline gate is now usable for Phase 1. Keep the main app free of these disposable
features, preserve both worktrees/raw records and the frozen packet, and retain the
same visible model/settings where practical for post A/B. Public recipe quality should
also address the observed resource-metadata mistakes. Actual leverage requires the
later structural audit and equivalent successful post exercises with less generic
integration work; it is not established by these baselines alone.
