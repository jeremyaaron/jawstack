# Phase 10 Evidence: Shared Content Commands and Records

Status: complete, uncommitted for user
review. Review base: `d9e8d25359943b617b0f74feb61fb5e493acf529`. No staging, commit, push,
tag, version bump, publication, remote dispatch or real AWS deployment occurred.

## Delivered

- Content declares one workflow and registers its existing receipt/publication-attempt
  schemas, exact keys and owners. A pure contribution creates those records and the same
  attempt projections. Editorial authorization, fact/attempt transition validation,
  approvals, fencing, immutable artifacts and live claim-response checks remain app-owned.
- The dispatch, memory and Dynamo modules are delegating facades. App-owned invocation
  capture, winner lookup/replay, transaction assembly, staging/locks, expiry and cancellation
  classification are removed. Shared storage preserves flat `APP_OPERATION` rows, legacy
  keys, scoped seven-day logical expiry, atomic receipts and response metadata.
- Existing memory pump, stream/SQS handlers and failure/recovery service remain the sole
  active delivery owner. No shared driver or placeholder handler is constructed; no second
  failure ledger is written. Shared memory publication retains native backing maps and
  cannot overwrite a concurrent domain notification projection with a stale collection copy.
- Command source is explicit throughout API, Lambda/job and synthesis wiring. Workflow
  fact registration unwraps readonly object schemas only for the shared object contract;
  the original complete Content parser still enforces outer refinements and target identity.
- Architecture and public workflow recipes document the migration and composition boundary.

## Composition Decision

The complete public factories required delivery bindings, but Phase 10 must not activate
a second delivery owner or introduce dummy handlers. Existing adapter-author implementation
pieces are now public: core `createWorkflowStorageSpec`, `createWorkflowCommandDispatch`,
`createMemoryWorkflowPersistence` and `WorkflowPersistenceFactory`; AWS
`createDynamoWorkflowStorage` and `compileWorkflowCommit`. This is a disclosed public-surface
extension, not a new command engine. The full runtime uses the same factored storage-spec
builder. The compiler still accepts only an opaque plan owned by its bound planner.

Table declaration ownership is shared between full and command-only Dynamo composition,
including rollback after failed full-runtime binding. Borrowed client/table validation and
mixed-declaration refusal happen before SDK calls. These low-level APIs are for trusted
adapter authors, not authorization boundaries or arbitrary-write HTTP endpoints. Full
workflow factories remain preferred for a new application.

One real regression was found during migration: malformed UTF-8 command input was classified
as `command.rejected` during request capture rather than Content's `command.validation`.
The shared dispatcher now classifies invalid captured JSON/UTF-8 as validation before any
persistence call, with four new core regressions. Mandatory invalid keys/identities still
use `command.rejected`; application assertions were not relaxed. Generic infrastructure
diagnostics now use shared wording; claim-fencing messages/metadata remain app policy.

## Verification

Focused checks passed on Node 24.16.0 / pnpm 10.21.0: Content typecheck/lint and 509 tests,
350 core tests, 251 AWS-runtime tests, and the frozen compatibility gate. New regressions
cover owned/frozen specification creation, command-only table ownership, invalid captured
input, declarative policy and a domain notification write during command work. Existing
both-adapter tests retain concurrent equivalence/conflict, logical expiry, auxiliary
rollback, exact projection movement, bounded conditions and stale-claim coverage.

The frozen fixture and acceptance file were not recaptured/edited. Test-only comparison
views are derived from the actual shared planner/compiler. To compare the old condition
encoding, they first require create-only activity/outbox conditions and the correct scoped
expiry alias, then normalize only those deliberate guard improvements for the historical
snapshot. Actual rows, keys, response/wire bytes, fingerprints and DTOs remain checked.

All **30 memory browser tests passed** (desktop 1440x900 and mobile 390x844, 6.2 minutes).
They exercise authoring, upload, review, scheduling, automatic publication, operations,
recovery, paging, conflicts, fixture isolation and error states. Existing layout assertions
pass. The desktop/mobile editor screenshots were visually inspected for text fit, controls
and section spacing; no UI source/style change was needed. Test servers used 4436/4437,
not the preserved review server on 4336/4337. Screenshots/results stay ignored under
`apps/content-operations/test-results/memory/`.

Final-source verification used `/tmp/jawstack-iteration3-phase10-verification`, a fresh
clone overlaid with Git-visible source only. Ignored dependencies/builds, tokens, manifests,
review data and browser results were excluded. `pnpm install --frozen-lockfile` and
`pnpm verify:release` passed with tests before builds and no preparatory build.

| Gate                        | Actual Final Result                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace tests             | 1,337: core 350, AWS runtime 251, CDK 73, Angular 44, CLI 20, generator 7, private lab 81, Work Requests 2, Content 509.             |
| Tooling/compatibility       | Eleven Node tests and one frozen compatibility test: 1,349 primary release tests, excluding the generated fixture's two tests.       |
| Typecheck/lint/format/build | Passed, including emitted package declarations.                                                                                      |
| Browser boundaries          | Passed; Angular remains 329 modules and zero server imports.                                                                         |
| Package guard               | Zero errors, warnings or info; no new suppression.                                                                                   |
| Generated app               | Install/lint/typecheck/two tests, browser/AWS builds, synth and doctor passed; no findings.                                          |
| Package dry runs            | All six passed. Core 257,049 bytes and AWS runtime 135,198 bytes unpacked; other four package contents/sizes unchanged from Phase 9. |

Built-entrypoint imports additionally confirm all five adapter-author functions are actual
exports, not declarations alone. The final release log was last written
`2026-11-02T05:22:05.682Z`, SHA-256
`83670247524badee55145e4c5f0f4aef463a29261073716808a951450b7e3802`, at
`/tmp/jawstack-phase10-release.log`. Browser log `/tmp/jawstack-phase10-browser.log` hashes
to `c1768df85c62da5e02cf14a0f7ff8d8dfb72e5684406d25dcfdd078df5f45238`.

All 37 changed/new non-Markdown source/config/test files match the final clone. SHA-256 of
their sorted `[path, fileSha256]` list:
`a925847090b07f14b8baeea222150adc8af20b1e81747d990790fa8ed6c7a606`.
Later documentation/status changes receive format/link/diff checks. Known prebuild
workspace CLI-bin, browser externalization/timing, color-environment and CDK feature-flag
notices remain nonblocking; zero findings above refers to package guard/doctor.

## Actual Local Proof

Fresh schema-2 lab `phase10check` used the unchanged pinned LocalStack image/digest, an
explicit existing ignored token file and user-attested Hobby setting. No token/environment
dump was taken. Browser/tests/build gates were idle during the service proof.

`scripts/verify-command-migration.ts` passed from `2026-11-02T05:11:00.878Z` through
`2026-11-02T05:12:22.535Z` (81,657 ms), after normal `local:up` / `local:provision`:

- Both memory and real Dynamo passed six concurrent creates and six concurrent edits,
  original-response replay, subject/command isolation, conflicting reuse, auxiliary and
  primary rollback, status/due movement, exact sort/partition changes and deduplication.
  The host command TTL fixture advances its injected instant by seven days to prove logical
  replacement of an undeleted expiry row; deployed workers use their normal clocks.
- The real transactional stream/bus/worker/S3 spine passed. Actual HTTP/upload/review,
  Scheduler, publisher and notification Lambdas completed one logical publication,
  three notifications and one succeeded attempt, with outbox/worker markers present.
  Eight ownership-proven warm runtimes were observed; delivery stayed external-worker owned.
- Owned down confirmed zero emulator containers, Lambda runtimes and networks, retained
  images, and removed manifest/routing/lock. Automatic child removal left no manual warm
  removals to count. Existing unrelated containers and review data were not reset.

This is the Phase 10 command/stream happy-path proof, not a rerun of Phase 9's full
fault/redrive/collector matrix, real AWS deployment or IAM enforcement. That broader
delivery migration remains Phase 11 work. The proof script refuses non-`phase10*` lab IDs,
uses shared ownership preflight/guarded clients, writes sanitized ignored evidence and
always attempts owned teardown in `finally`.

Sanitized evidence/logs and SHA-256:

- `/tmp/jawstack-phase10-up.log`:
  `0ce152797b0894f32949593175f70c6d0549d9fccce99530e74f4da3eee8f3a5`.
- `/tmp/jawstack-phase10-provision.log`:
  `fab1ea12302c3a30ab6a461580f04b211bfe404414eb77cf0056f89e8422663a`.
- `/tmp/jawstack-phase10-live.log`:
  `9601225dbad8bbccb3becfb9ecbc17c7a52acfd331bcfb580d56dcf94f3d55cf`.
- Ignored `apps/content-operations/.localstack/phase10check-command-evidence.json`:
  `2ea554b2419881fd111b3fd12fdfa42d741a5d8de8c0a33f99f6265460dafa38`.

## Integrity and Measurement

See the [migration ledger](leverage/phase-10-migration.md) and separate working post inventory.
The frozen denominator, original inventory, PRD/TDD, task packets and compatibility JSON
remain unchanged. Public APIs/source grew as disclosed above; package versions, dependency
manifests and lockfile did not change. The compatibility capture helper is a disclosed
changed baseline input: it now consumes the shared compiler and validates/normalizes the
new immutable/expiry conditions instead of calling the retired app compiler.
Its current SHA-256 is `7e5402068c35d202ba89d750e17131721ff44e5e2503c8a17671ec94aa18f108`.
Both frozen task packet `--check` commands pass; no A/B feature exercise was executed.

Current working protocol count is **1,589 -> 1,370 (-219)**, including new workflow and
extra composition sites; separate lab stays **443**. Core grows **15** token-lines, AWS
runtime **17**, CDK/private lab stay unchanged. The 50% structural gate and paired leverage
verdict remain unfinished; no post A/B exercise or refreeze occurred.

The review API remained healthy; its maintained item stayed version 3 / draft. No review
server was restarted or its data reset. No test-owned emulator/network remains.

Next: Phase 11 migrates the single delivery/recovery owner. Changes remain uncommitted
for user review.
