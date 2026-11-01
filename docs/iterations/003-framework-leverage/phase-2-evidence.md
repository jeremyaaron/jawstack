# Phase 2 Evidence: Scoped Commands and Memory Atomicity

Status: complete, uncommitted for user review. Final clean release verification passed
after undefined-row hardening. Review patch based on
`1fc3fdbb19872d1d639f6e67a2f5f225cde96dd8`. No staging, commit, push, version bump,
publication or deployment occurred.

## Delivered

- Internal `workflow/command-runtime.ts` composes `executeCommand`; it does not duplicate
  authorization, input parsing, fingerprints, decisions or response construction. Every
  invocation captures detached frozen request/auth data, private scope and one instant.
  Ingress `requestContext` is never read or forwarded, even when implemented as a getter.
- Scoped persistence requires an ASCII key of 1-200 characters. Tenant-bearing auth and
  stored resource/idempotency rows reject; the shared planner rejects tenant-bearing
  emitted events. Both planned consumers select seven-day expiry explicitly. Logical
  expiry and conditional replacement work while the expired physical row still exists.
- Eligible conflict/unavailable results get at most four winner lookups with pauses
  0/10/25/50 ms. A winner is pinned into the existing executor's authorization/schema/
  fingerprint path, with state reads and commit disabled. No second mutation decision
  runs. Equivalent replay preserves the committed response's original metadata. Missing
  or unavailable lookup leaves the original error; corrupt data is not a cache miss.
- `validateResult` sees frozen captured request/result, detached read-only state and a
  live-clock accessor. It can reject successful authority but cannot return a replacement
  or promote an error to success. Invocation-local `AsyncLocalStorage` guards framework
  dispatch/commit calls from the hook and its asynchronous descendants, without blocking
  unrelated concurrent invocations. It contains only a read-only flag, not auth/scope.
- Internal `workflow/memory.ts` consumes its bound planner's opaque plans. It stages
  detached actions, serializes commits, checks all conditions and publishes synchronously
  without yielding. Only touched keys change, so domain notification/job projection
  writes made before the lock continuation survive. Exact projection deletion retains
  other sorts for the same item. Immutable activity/outbox/auxiliary collisions and
  resource-version conflicts publish nothing; the queue remains usable after rejection.
- `workflow/stored.ts` shares planner schemas and JSON bounds for detached stored-state/
  scoped-idempotency reads. Invalid data maps to redacted `resource.invalid_state`,
  including logically expired corrupt rows. Generic unexpected errors stay redacted.

These are internal backend modules until Phase 4 delivers full public composition.
No public factory, package export, app migration, failure ledger or Dynamo compiler was
added. Application and legacy persistence behavior remain unchanged. Empty, exclusively
owned native memory backing is required; unrelated/nonempty stores cannot be adopted.
The backing store remains available to trusted non-yielding domain writers. Reset must
replace the complete runtime, not clear only its legacy store or remount another workflow.

Read-only hooks are not a JavaScript security sandbox. Trusted application closures can
still misuse raw maps, external clients or legacy APIs; these are not exposed by the hook.
Domain authorization, publication leases and fencing remain application responsibilities.

## Verification

Focused core typecheck/lint and all **202 core tests** passed, including **49 new tests**:
concurrent equivalent and conflicting intents, scoped subjects/types/commands, distinct
keys racing on one resource, immutable invocation capture, invalid keys, revoked roles,
logical expiry/replacement races, uncertain commits/late visibility/bounded misses,
pinned schema replay, lookup unavailability/corruption, exact projection moves, staged
domain-store interleaving, all-category rollback, ownership/plan provenance, detached
reads, corrupt stored rows (including explicit undefined map entries) and result-hook
restrictions/concurrency/stale authority.

The memory adapter also persists the frozen legacy fixture's actual state/activity/event
bytes, projection identity, command receipt and scoped response. Existing planner and
legacy executor/repository tests remain unchanged. During development, focused tests
caught two fixture mistakes (a legitimate event name matched an overly broad assertion,
and a command omitted its required event declaration); typecheck caught Zod's explicit
optional-undefined input type. Corrected fixtures/types, not production assertions.
Final review found and fixed explicit undefined backing entries being mistaken for absent
rows; three regressions now require invalid-state rejection without publication.

A fresh clone `/tmp/jawstack-iteration3-phase2-final` overlays Git-visible source on the
commit above, excluding ignored dependencies, outputs, tokens, manifests, benchmark raw
data and interactive review data. Ran `pnpm install --frozen-lockfile`, then
`pnpm verify:release`, with **tests before package builds** and no preparatory build.

| Gate                         | Actual result                                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Clean frozen install/release | Passed on Node 24.16.0 / pnpm 10.21.0.                                                                                                 |
| Workspace tests              | 900 passed: core 202, AWS runtime 76, CDK 36, Angular 42, CLI 20, generator 7, Work Requests 2, Content 515.                           |
| Tooling/compatibility        | Eleven Node tests and one frozen golden test passed; 912 release tests in total, excluding the separate generated fixture's two tests. |
| Typecheck/lint/format/build  | Passed in the clean clone.                                                                                                             |
| Browser boundaries           | Package and consumer checks passed; Angular package report retained 329 modules and zero server imports.                               |
| Package guard                | Zero errors, warnings or info.                                                                                                         |
| Generated app                | Install/lint/typecheck/two tests, browser and AWS builds, synth and doctor passed; doctor had no findings.                             |
| Package dry runs             | All six passed; core unpacked size 131,365 bytes. Nothing published.                                                                   |

Final release log `/tmp/jawstack-phase2-final-release.log`: created
`2026-11-01T22:28:12.341Z`, last written `2026-11-01T22:30:43.283Z`, SHA-256
`c3d747a5fc30ab8ef937e278acdf868e6fd9d889d22cec3826e3d6df6161316d`.
These are log timestamps, not agent-effort measurements. Final install log
`/tmp/jawstack-phase2-final-install.log` retains the known missing prebuild workspace
CLI-bin warning. Existing browser externalization/CDK feature-flag/build-timing notices
also remain nonblocking; zero findings above applies specifically to package guard/doctor.

The earlier clean release also passed at `/tmp/jawstack-phase2-release.log`. It predates
undefined-row hardening; final acceptance uses the complete rerun above, not that earlier
source. All 15 core source/test files match the final clone, with aggregate SHA-256 of
the sorted `[path, fileSha256]` list:
`9f82cd6c34b6849abf803abb593bd190e373bd036492f464b3761429b8d53b9c`.

Final status/evidence/index changes after that gate are Markdown only. Formatting,
local-link and diff audits cover those edits. No fresh full Content browser acceptance or
LocalStack suite ran. Earlier live evidence is not relabeled a new pass; actual service
atomicity, delivery and consumer migration remain later gates.

## Growth and Integrity

The frozen counter reports core growth from Phase 1's **3,311 to 3,846 token-lines**,
**+535** this phase and +1,245 since the frozen baseline. This includes internal executor,
memory adapter, stored-row validation and read-only context machinery. It is real framework
complexity despite adding no public export/subpath or package dependency this phase.
Public composition is intentionally deferred, not represented by a placeholder factory.

Selected consumer protocol code remains **1,589 token-lines**, with separate lab code at
1,552. No retirement or agentic leverage improvement is claimed before migration/post
exercises. Frozen input hashes and inventory are unchanged; baseline worktrees/task results
remain untouched. The frozen-source verifier intentionally rejects post-baseline framework
changes; the baseline has not been refrozen to hide growth.

Main app runtime, AWS runtime/CDK source, lockfile, package exports and versions are
unchanged. Read-only checks confirm the 4337 API remains healthy, `memory` / `managed`,
with content `10000000-0000-4000-8000-000000000002` still version 3 / draft. No interactive
process/data was restarted/reset, env/token read, Docker/lab started, real AWS used,
remote workflow dispatched or secret configured. The staged diff remains empty.

Next: Phase 3 implements durable failure/recovery services before Phase 4 assembles the
complete public memory workflow. Content Operations still uses its existing persistence.
