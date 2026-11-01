# Phase 3 Evidence: Durable Failure and Recovery

Status: complete, uncommitted for user review. Clean release verification passed. Review
patch based on `feb8ab255c81c989398ba1c10ebb03e675d7bbd9`. No staging, commit, push,
version bump, publication or deployment occurred.

## Delivered

- Internal `workflow/failure-records.ts` supplies the generic bounded record contract,
  canonical base envelope, fact-validation callback, stable tuple IDs/fingerprints,
  exact replay construction, immutable history checks and operational projection/query
  mapping. Its schemas contain no Content Operations consumer names, fixture identities,
  publication rules or hard-coded application resource types.
- `workflow/failure-memory.ts` persists failure history, its summary projection and an
  optional create-only replay outbox event together. It shares Phase 2's backing store
  and serialized lock, stages detached values, checks CAS/collisions/capacity, and makes
  only synchronous touched-key writes. Domain projection changes are not overwritten
  by a stale cloned store. Empty/exclusive ledger ownership is required; cloning the
  private persistence wrapper does not permit a second ledger mount.
- `workflow/failures.ts` implements validation -> durable pending collection -> repeatable
  application reconciliation -> durable settled collection. Crashes and live-claim/hook
  errors leave pending work unacknowledged and resumable, never silently not-applicable.
  An absent reconciliation hook defaults to `notApplicable`; an installed throwing hook does not.
- Root operations authorization is required for inspect/replay, including duplicate
  replay requests. It must explicitly return `true`; absence, errors or unknown outcomes
  deny. Optional consumer eligibility can only further restrict new replay requests.
  Policies are `replay` or `application`; the latter remains inspectable but cannot queue
  a generic recovery. Actors come only from a detached resolved `AuthContext`.
- Replay retains one candidate UUID/time across at most three strong-read/CAS attempts.
  A final read recognizes an applied third commit whose response was lost without a
  fourth write. Matching request UUIDs converge on recorded history; queued work cannot
  consume another generation. Recovery uses the normal outbox, never a direct send.
- Recorded-envelope authorization validates exact original identity, payload, actor,
  source, trace, timestamp, target and latest generation before delivery/collector use.
  Non-target subscribers can authenticate an ignored fanout copy but cannot complete it.
  Completion is monotonic; a late failed collection cannot undo durable completion.
- `workflow/failure-context.ts` blocks ledger writes/reentry from reconciliation, including
  asynchronous descendants, while allowing ordinary authorized business commands.
  Policy callbacks use the existing read-only invocation guard. `workflow/identity.ts`
  shares Phase 2's identity capture/validation without changing its behavior.

These are internal backend modules until Phase 4 supplies the complete public workflow.
No alternate Content Operations writer, app migration, public factory/subpath, failure
HTTP route, managed delivery loop or Dynamo adapter was activated. The event registry and
transport wrappers remain Phase 4 work; the internal pure fact validator must enforce
domain payload/schema/target identity. It cannot perform I/O or return a Promise.

## Semantics and Bounds

Failure identity is SHA-256 of `[consumer, originalEventId]`; fingerprints retain canonical
version-1 wire ordering. Original payload/fingerprint/consumer/first collection instant
cannot change. Terminal collection history cannot be rewritten or truncated, recovery
requests only append, and resolved generations never regress. The store uses the existing
`FAILURE#<hash>` / `DELIVERY` family and configured operational projection namespace.

There are at most three operator recovery cycles and four collection stages. New replay
request and transport IDs are UUIDs; stored legacy transport IDs remain bounded ASCII,
including the frozen non-UUID fixture. Request IDs retain their original actor/history
on retry, while root access is rechecked. An already-recorded request returns current
history even if business completion now makes a new replay ineligible. Targeted facts
from superseded generations reject; current recorded duplicates remain authentic after
completion, so later marker checks/business guards can safely handle them.

Rows are bounded to 128 KiB including storage family/kind overhead, without TTL. Memory
capacity defaults to 1,000 records, with explicit integer overrides 1-10,000; it rejects
instead of evicting. Fact payloads default to 80 KiB and may be configured narrower.
Inspection defaults to fifty summaries, maximum one hundred, using existing opaque
keyset cursors. It exposes bounded history/trace fields, never the original payload,
fingerprint, credentials, publication tokens, raw storage keys or exception stacks.

Reconciliation receives a frozen private failure DTO and generation, not ledger writers.
It must be repeatable, strongly reread application authority and use domain versions/
fences. Its business transaction and the ledger are explicitly not one transaction.
Advisory replay eligibility is not a lock: handlers must recheck business completion when
a benign redundant replay races application state. Markers do not prove business success.
Framework guards are not a JavaScript security sandbox for trusted raw maps/external
clients captured by application closures.

## Verification

Core typecheck/lint and all **270 core tests** passed, including **68 new tests**. Coverage
includes duplicate/concurrent collection, persisted pending-before-hook behavior, both
collection crash points, live-claim deferral, resumed current authority, late completion,
ledger reentry/async isolation, authorized business commands, immutable snapshots,
invalid/tenant/unrecorded traffic, root/eligibility denial, application-only policy,
concurrent/deduplicated replay, stable candidate identity, ambiguous third-commit readback,
post-replay crash recovery, exact/foreign/stale envelope authorization, history regression,
retention/byte bounds, rollback, corrupt rows/projections, paging and inspection redaction.

The frozen legacy fixture is read without changing its IDs/fingerprint/history. Actual
new memory writes reproduce its failure row, summary, projection physical key and replay
wire bytes. Existing Phase 1/2 and legacy executor/repository assertions remain unchanged.
Typecheck caught contextual async literal-return and exact optional-field fixture issues;
these were corrected without weakening production assertions.

A fresh clone `/tmp/jawstack-iteration3-phase3-verification` overlays Git-visible source
on the commit above, excluding ignored dependencies, outputs, tokens, manifests,
benchmark raw data and interactive review data. Ran `pnpm install --frozen-lockfile`,
then `pnpm verify:release`, **tests before package builds**, without a preparatory build.

| Gate                         | Actual result                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Clean frozen install/release | Passed on Node 24.16.0 / pnpm 10.21.0.                                                                                                |
| Workspace tests              | 968 passed: core 270, AWS runtime 76, CDK 36, Angular 42, CLI 20, generator 7, Work Requests 2, Content 515.                          |
| Tooling/compatibility        | Eleven Node tests and one frozen golden test passed; 980 primary release tests, excluding the separate generated fixture's two tests. |
| Typecheck/lint/format/build  | Passed in the clean clone.                                                                                                            |
| Browser boundaries           | Package and consumer checks passed; Angular package report retained 329 modules and zero server imports.                              |
| Package guard                | Zero errors, warnings or info.                                                                                                        |
| Generated app                | Install/lint/typecheck/two tests, browser and AWS builds, synth and doctor passed; doctor had no findings.                            |
| Package dry runs             | All six passed; core unpacked size 131,812 bytes. Nothing published.                                                                  |

Release log `/tmp/jawstack-phase3-release.log`: created `2026-11-01T23:06:21.680Z`, last
written `2026-11-01T23:09:39.213Z`, SHA-256
`300c6a379d11d332c7924064674f86b1a9ebfd6ce3bdbfd743d78730fee20c8b`.
These are log timestamps, not agent-effort measurements. Install log
`/tmp/jawstack-phase3-install.log` retains the known missing prebuild workspace CLI-bin
warning. Existing browser externalization/CDK feature-flag/build-timing notices remain
nonblocking; zero findings above applies specifically to package guard/doctor.

All 21 core source/test files match the clean clone. SHA-256 of their sorted
`[path, fileSha256]` list:
`b92e63b6526af8c44fd46bbaf2f0dea0454be5c2fd8d42f6d08fad654f344f7c`.
Final status/evidence/index changes after the release gate are Markdown only, covered by
format/link/diff audits. Memory persistence is process-local: these results do not prove
process-restart durability, service transaction atomicity, transport acknowledgement or
live delivery. No fresh full Content browser or LocalStack suite ran; later Dynamo/live
gates must establish those properties. Earlier evidence is not relabeled a new pass.

## Growth and Integrity

The frozen counter reports core growth from **3,846 to 4,794 token-lines**, **+948** this
phase and +2,193 since the frozen baseline. That is real framework/concept burden:
failure schemas/history, private service/adapter contracts, shared native memory locking
and callback authority guards. No public export/subpath, package or dependency was added.
The complete public composition is still Phase 4, not a placeholder factory.

Selected consumer protocol code remains **1,589 token-lines** and separate lab code
1,552. No structural retirement or improved agent integration is claimed before consumer
migration/post exercises. Frozen input hashes and inventory remain unchanged; baseline
worktrees/task results are untouched. The frozen-source verifier intentionally rejects
post-baseline framework changes; the baseline was not refrozen to hide growth.

Main app runtime, AWS runtime/CDK source, lockfile, public package exports and versions
are unchanged. Read-only checks confirm the existing 4337 API remains healthy,
`memory` / `managed`, and content `10000000-0000-4000-8000-000000000002` remains version
3 / draft. No interactive process/data was restarted/reset, env/token read, Docker/lab
started, real AWS used, remote workflow dispatched or secret configured. The staged
diff is empty.

Next: Phase 4 adds validated workflow declaration/binding, delivery and the complete
public memory composition. Content Operations migration remains in Phases 10-11.
