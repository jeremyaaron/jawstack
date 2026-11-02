# Iteration 3 Implementation Plan: Framework Leverage

Status: reviewed; Phase 0 and baseline A/B are complete. The
[baseline review](baseline-review.md) clears the prerequisite with explicit timing
qualifications. Phases 1-5 are complete; Phases 6-14 and post A/B have not started. Based on the [PRD](prd.md) and
[technical design](technical-design.md); see [Phase 0 evidence](phase-0-evidence.md).

## Purpose

Turn two proven Content Operations protocols into useful public JawStack capabilities:
invocation-scoped atomic commands and durable worker failure/recovery operations. Migrate
that consumer, demonstrate independent reuse in headless Report Runs, and measure whether
the result actually reduces agent integration work.

This plan has 15 implementation phases, numbered 0-14. Each is one code -> user review ->
user commit cycle. The agent implements and verifies; the user reviews and commits.
Four fresh-session change exercises require separate user coordination; they are explicit
gates, not work silently included in an implementation turn.

Finishing features is not sufficient: preserved behavior, installed-package independence,
real local delivery, structural retirement and positive reviewed leverage evidence are all
required. This is not a release plan or authorization to publish a new version.

## Execution Rules

- Read current source and prior phase evidence first. Preserve unrelated changes and the
  user's running review environment/data. Use fresh lab identities and isolated checkouts
  for destructive verification; never reset the interactive Content Operations dataset.
- Do not stage, commit, push, merge, tag, publish or bump versions. Do not automatically
  spawn benchmark agents, purchase services, dispatch remote CI or upload secrets.
- Keep phases buildable and testable, with tests for behavior actually implemented. Do not
  add failing future-feature tests to normal CI or export placeholder factories/handlers.
- Before starting each phase, check its estimated diff against one reviewable implementation
  cycle. If too large, propose a split before coding and update dependencies with review;
  the 15-phase target is not permission to compress several unreviewed turns into one.
- Follow existing package patterns. Applications consume public exports, never another app,
  package internals or private lab APIs from installed runtime code. Shared lab tooling
  may depend on public local transport policy, never the reverse.
- Preserve legacy opt-in behavior, generated Work Requests and existing Content Operations
  assertions. Do not weaken tests, change baseline classifications or hide replacement
  code to satisfy a metric.
- Keep editorial decisions, publication claims/fences, artifacts, uploads, notifications
  and recurring-job policy application-owned. Do not grow a workflow/lease/DAG engine.
- Update working recipes with the phase that makes them usable. Mark proposed APIs and
  commands as proposed until delivered. Final documentation is an audit, not permission
  to leave earlier phases undocumented.
- Record commands, source/configuration identity, durations and passed/failed/not-run
  outcomes as work proceeds. A blocked or missing prerequisite is not a passing gate.
- Keep tokens, env files, ownership manifests and raw traces out of committed evidence.
  Importing code and running default checks must require neither secrets nor Docker/network.

## Verification Levels

Use `.nvmrc`, the pinned pnpm and frozen lockfile. Every code phase runs focused tests,
affected typecheck/lint/build checks, formatting and `git diff --check`. Documentation-only
changes run formatting and local Markdown link checks. Run expensive gates sequentially.

The following commands already exist; their coverage must be extended as new workspace
packages arrive, not treated as covering them automatically:

```sh
pnpm format:check
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm pkg:check
pnpm verify:generated
pnpm verify:pack
pnpm verify:release
pnpm --filter content-operations test
pnpm --filter content-operations test:browser
pnpm --filter content-operations test:browser:local
pnpm --filter content-operations verify:local
```

`verify:release` is not the whole iteration gate. It does not by itself prove a pristine
install, Report Runs' installed composition, full browser acceptance or actual local
delivery. New leverage/installed-report scripts are deliverables of Phases 0/13, not
commands assumed to exist today.

Public-contract changes run dependent-consumer regressions, package checks/dry runs and
isolated generated-app verification as appropriate. Preserve credential-free import and
source-alias regression tests, including intentional public subpaths. At public runtime
milestones (Phases 4-7), consumer migrations (10-12) and final acceptance (13-14), verify
the workspace from a clean frozen install with tests before package builds. Do not use a
developer's existing `dist` files or prebuild to hide a test-resolution defect.

Memory parity tests and mocked SDK failures are required but do not establish live
atomicity, stream delivery, redrive or collector recovery. Browser checks use actual
servers and Playwright, with desktop/mobile screenshot inspection and browser bundle
boundary checks. Live gates retain normal queue visibility/retry timing and finite bounds.

## Coordinated Gates

### Baseline Exercises: Before Phase 1

Phase 0 produces a frozen inventory and runnable exercise packets. Then the user opens
two fresh sessions, baseline A and baseline B, against separate copies/worktrees of the
approved baseline. These are separate observations, not continuation work in this session.

Both sessions receive identical task specifications and neutral acceptance fixtures to
their eventual post-extraction counterpart. They may use all existing supported APIs;
do not manufacture a worse baseline. Keep each feature patch disposable and separate from
the shipping application. Record failures/partial attempts as well as successes.

Phase 1 is gated on reviewed baseline identity, inventory, task equivalence and actual
baseline observations. If an exercise cannot establish usable comparable evidence, pause
extraction for a scope/measurement decision rather than fabricating results or silently
discarding the failed attempt. Phase 0's packet readiness is not completion of this gate.

### Post Exercises: After Phase 13, Before Phase 14

Freeze the reviewed functional candidate and its public recipes after Phase 13 passes.
The user opens two fresh sessions, post A and post B, with the same tasks, fixtures,
agreed model/tool settings and budgets. Do not provide the opposite solution patch or
reuse a baseline session's private context. Public docs/types and normal source inspection
are allowed; record any need to understand private framework machinery.

Each attempt has a thirty-minute active elapsed budget plus separately bounded and
recorded install/service waits. Freeze the precise settings before baseline execution;
record deviations rather than normalizing them away. Measure visible session events and
the union of wait intervals, not inferred model thinking time. Tokens are unavailable
unless the client reports actual usage. No paid API or agent spawning is implied.

Post work must pass equivalent tests without framework-internal edits or reimplementation
of the extracted protocols. A candidate runtime/API/profile change invalidates affected
verification and exercise evidence: review the change and rerun the affected gates. Do
not cherry-pick a favorable attempt from unlimited retries. An inconclusive/negative
comparison requires an explicit scope decision and is a no-go for the accelerator claim.

### Local Safety and Feasibility

Before live phases, recheck Docker/resources, the pinned LocalStack image/digest and
user-attested Hobby entitlement. Existing ignored token files are input, never evidence
to print or search elsewhere. No paid trial or real AWS fallback. Only explicit startup
uses the token; reset/down and safe cleanup must not depend on it.

Use isolated project/lab IDs and run the two service profiles sequentially because of
the fixed local endpoint. Record startup, service-path and teardown failures honestly.
Unavailable prerequisites leave live acceptance incomplete, even if all unit tests pass.
Planning approval does not authorize remote environment changes, secret setup or AWS deploys.

## Phase Index

| Phase | Primary Owner              | Deliverable                                                     | Status   |
| ----- | -------------------------- | --------------------------------------------------------------- | -------- |
| 0     | Measurement/tooling        | Frozen inventory, golden fixtures and baseline exercise packets | Complete |
| 1     | Core                       | Typed records and normalized adapter-neutral commit plans       | Complete |
| 2     | Core                       | Scoped command execution and atomic memory persistence          | Planned  |
| 3     | Core                       | Durable failure collection, inspection and replay decisions     | Planned  |
| 4     | Core                       | Validated delivery, bounded memory pump and public composition  | Planned  |
| 5     | AWS runtime                | DynamoDB workflow storage and atomic recovery                   | Planned  |
| 6     | AWS runtime                | SQS workflow handlers and safe public local composition         | Planned  |
| 7     | AWS CDK                    | Opt-in collector topology and stable named bindings             | Planned  |
| 8     | Shared lab                 | App-neutral ownership, startup and teardown                     | Planned  |
| 9     | Shared lab/Content tooling | Finite provisioning/reset and Content lab migration             | Planned  |
| 10    | Content Operations         | Command/record migration with preserved publication authority   | Planned  |
| 11    | Content Operations         | Shared delivery/recovery migration and protocol retirement      | Planned  |
| 12    | Report Runs                | Complete headless memory/local consumer                         | Planned  |
| 13    | Integration/tooling        | Installed consumer, final live gates and frozen candidate       | Planned  |
| 14    | Evidence/documentation     | Leverage verdict, acceptance audit and merge readiness          | Planned  |

Follow this order. Baseline A/B are mandatory between Phases 0/1; post A/B between 13/14.
Later phases may not be used to conceal a knowingly broken earlier phase. New public
factories appear only when their complete advertised surface works; earlier work can use
package-internal contract harnesses without publishing a partial runtime.

## Phase 0: Freeze Baseline and Exercise Packets

Goal: establish a fair, reproducible before-state before changing framework behavior.

Scope:

- Inspect the actual approved checkout and record source commit plus any relevant patch,
  lockfile/doc hashes, Node/pnpm/model/tool settings and existing verification results.
  Do not assume the historical design's inspected commit is still the baseline.
- Create `leverage/baseline.json`, task A/B specifications and neutral acceptance fixtures
  under this iteration. Keep benchmark fixtures outside normal test discovery. Do not
  create empty future outcome/results files.
- Inventory selected Content Operations generic dispatch/persistence/delivery/recovery
  symbols with AST spans, source hashes and reviewed classifications. Exclude domain
  subtrees inside mixed methods; separately account for local tooling and API growth.
- Capture current key/row/envelope/fingerprint/DTO golden fixtures before extraction,
  with provenance and no secrets. Later adapter tests consume this frozen compatibility
  reference rather than recording their own new output as the expected legacy format.
- Implement `scripts/measure-leverage.mjs` with tested TypeScript-token line counting,
  overlap deduplication and source-hash/span validation. Freeze formatting/counting rules;
  include app-maintained generated runtime code, exclude tests/docs/comments/build output.
- Prepare runnable isolated task acceptance harnesses: A atomic approval receipt including
  conflict rollback; B publication receipt via an internal resource/consumer with retry,
  recovery and permanent business deduplication. Use the same schemas/keys/assertions in
  both snapshots, without prescribing a disadvantaged baseline implementation.
- Document copy/worktree creation, clean reset between tasks, explicit local verification,
  timing/wait capture, sanitized result format and ignored raw artifacts. Smoke-test the
  runner's setup/error paths without claiming the unimplemented tasks pass.

Acceptance: immutable baseline inputs and denominator are reviewable; the counter is
deterministic; both exercise packets are executable; existing functionality remains green.
The baseline exercises themselves remain a separately recorded prerequisite to Phase 1.

Verification: counter/fixture-runner tests, current clean-install release and memory
browser baseline, local link/format checks. Freeze or rerun the existing local acceptance
baseline needed to compare migration behavior; distinguish prior evidence from fresh runs.

## Phase 1: Typed Records and Logical Commit Plans

Depends on: Phase 0 and the reviewed baseline A/B gate.

Goal: establish one complete, backend-neutral atomic vocabulary, not an SDK write DSL.

Scope:

- Implement registered record schema/key/owner validation and create-only contributions.
  Contributors are synchronous/pure and cannot issue I/O, return promises or mutate
  unrelated resource state. Reject undeclared collections and mismatched root ownership.
- Normalize primary CAS/create, immutable activity/outbox, exact projection puts/deletes,
  scoped idempotency and auxiliary creates. Coalesce only the specified identical or
  compatible projection actions; reject every other physical-key collision.
- Enforce the design's 60 actions, per-record/auxiliary/total byte budgets and JSON depth/
  node limits before writes. Validate current Content fixtures against those bounds.
- Define the minimal supported core-to-AWS adapter contract through package exports,
  without exposing application-supplied raw plans/conditions or forcing deep imports.
- Freeze golden current keys/rows/envelopes/fingerprints/DTOs in compatibility tests.
  Pure constructors may be exported when complete; do not export unfinished factories.

Acceptance: valid plans normalize deterministically; invalid contributions fail before
any effects; no tenant support or arbitrary transaction extension is implied. Existing
Content storage/wire formats have explicit golden coverage, including immutable-key conflicts.

Verification: pure plan/property-boundary tests, public type tests, current fixtures,
affected core/AWS and legacy consumer regressions. No consumer migration yet.

## Phase 2: Scoped Commands and Memory Atomicity

Status: complete; see [Phase 2 evidence](phase-2-evidence.md). Public composition remains
in Phase 4; no application migration or live DynamoDB behavior is claimed here.

Depends on: Phase 1.

Goal: execute scoped commands safely without duplicating the existing core command engine.

Scope:

- Compose `executeCommand` using detached per-invocation auth/request data and one captured
  instant. Remove untrusted request context from hooks; never use mutable current-request
  state. Scope keys by resource type/command/subject, with bounded mandatory key validation.
- Reject tenant-bearing invocations, events and stored rows for this new capability only.
  Implement seven-day logical expiry and conditional replacement without waiting for TTL.
- On ambiguous commits/conflicts, use the specified bounded strong replay lookups and
  pinned authorization/schema/fingerprint checks. Never reload state or rerun a decision
  to turn an uncertain result into another write. Preserve original response metadata.
- Implement read-only result validation that can reject stale claim success but cannot
  rewrite results or perform a commit.
- Apply the shared plan to memory through serialized detached staging and synchronous
  publication. Preserve the backing store for domain job/notification services without
  stale snapshot overwrites across asynchronous work.

Acceptance: concurrent subjects/commands/targets are isolated; equivalent retries converge,
conflicting intents reject, expired rows replace safely, and every failed auxiliary or
projection condition leaves all state/activity/outbox/idempotency unchanged.

Verification: concurrency/ambiguity/expiry and result-hook tests, immutable snapshot and
rollback tests, golden rows and legacy executor/repository regressions. Exercise the new
engine internally until the full public memory factory is ready in Phase 4.

## Phase 3: Durable Failure and Recovery Service

Status: complete; see [Phase 3 evidence](phase-3-evidence.md). The service and memory
adapter remain internal until Phase 4; Content Operations still has one existing writer.

Depends on: Phase 2.

Goal: centralize bounded delivery history without taking over business completion authority.

Scope:

- Implement the generic failure schema/store and monotonic CAS transitions, preserving
  current keys, fingerprints, summaries, row/history limits and projection behavior.
  Inspection is paged/redacted; no raw original envelope escapes the operations API.
- Implement collection as validate -> durable pending row -> application reconcile ->
  durable settled row. Throwing/live-claim reconciliation remains unacknowledged and
  resumable; it must not be relabeled successful or not-applicable.
- Require root operations authorization, with application replay eligibility as an
  additional restriction. Keep publisher policy application-only; absence denies access.
- Record stable recovery UUIDs and targeted generations, with at most three cycles.
  Atomically persist recovery history/projection and a create-only outbox event. Read back
  ambiguous outcomes by request ID; never publish directly to EventBridge/SQS.
- Implement recorded-envelope authorization and completion semantics for delivery to use
  next phase, including current business state winning races against stale ledger state.

Acceptance: interrupted collection/replay resumes without history regression, duplicate
cycles or lost durable intent. An application hook is not falsely claimed to share the
ledger transaction. Arbitrary/stale/forged recovery envelopes cannot authorize delivery.

Verification: memory CAS/concurrent replay/failure-capacity tests, authorization/summary
bounds, rollback and ambiguous commits, application-hook failure/retry fixtures and current
failure-row golden compatibility. No alternate Content failure writer is activated yet.

## Phase 4: Delivery and Complete Public Memory Composition

Status: complete; see [Phase 4 evidence](phase-4-evidence.md). The public memory factory
and adapter contract are usable; Dynamo/live delivery and app migration remain later work.

Depends on: Phase 3.

Goal: expose a genuinely usable public workflow, not independent pieces requiring app glue.

Scope:

- Finish `defineWorkflow`, immutable function-free manifest and exact synchronous binding.
  Derive subscriptions from existing workers; reject missing/extra/inherited consumer
  names, duplicate declarations, mixed bounds and dispatch during binding.
- Validate registered envelope schemas/source/identity and reserved delivery metadata.
  Authorize targeted recovery before any marker, including marker cache hits; authorize
  ignored fanout without accidentally executing non-target handlers.
- Sequence business completion, targeted recovery resolution and processing marker in
  that order. Document markers as deduplication aids, not locks or exactly-once guarantees.
- Implement bounded fanout, retry/collector deferral, cursor safety and admission in the
  shared memory pump using injected time. Finish bounded drain/drain-until-idle and
  explicit serialized start/stop/close without advancing the application's clock.
- Export complete `createMemoryWorkflow` services and the functioning adapter contract.
  Add command/contribution and consumer/recovery public recipes plus a small test fixture
  using only supported imports. No application SDK transaction/pump required.

Acceptance: one public composition runs request -> command -> event -> worker -> failure ->
authorized replay -> completion in memory. Import/configuration has no clients, timers or
I/O; no-op handlers and partial public methods are forbidden. Legacy resources stay unchanged.

Verification: end-to-end public-import tests, queue/marker/failure caps and full-fanout
backpressure, retry timing/close behavior, reserved metadata and no-I/O import tests;
clean test-before-build release/generated/package gates and browser boundary regression.

## Phase 5: DynamoDB Workflow Storage

Status: complete; see [Phase 5 evidence](phase-5-evidence.md). Shared Dynamo storage and
the owned local-table probe passed; full transport and consumer migration remain later work.

Depends on: Phase 4.

Goal: provide the same command/recovery contracts using one conditional DynamoDB commit.

Scope:

- Implement the known-plan compiler and shared workflow stores using supported core
  exports. Do not copy the planner/executor or accept user-supplied SDK write fragments.
- Compile all command conditions/contributions and recovery history/outbox writes into
  single `TransactWriteItems` operations, defensively enforcing DynamoDB size/action bounds.
- Implement strong reads, absent-or-expired idempotency replacement and known conditional
  conflict classification. Preserve unavailable/invalid-state errors and bounded ambiguous
  readback rather than guessing a successful or retryable decision.
- Export complete `createDynamoWorkflow`; it exposes no memory pump. Keep existing AWS
  repositories/unit-of-work/builders and legacy defaults supported.

Acceptance: the shared memory/Dynamo contract matrix passes, including auxiliary conflicts,
rollback, projection movement, logical expiry, corruption and uncertain commit outcomes.
Both old and new writes use the approved compatibility formats.

Verification: compiler/SDK failure tests, parity suites and clean release/package checks;
an isolated real local-table transaction probe for rollback, conditional replacement and
strong replay, with owned setup/cleanup. This probe is not full stream/delivery acceptance.

## Phase 6: SQS Binding and Public Local Runtime

Depends on: Phase 5.

Goal: make AWS worker execution and installed-consumer local composition safe and reusable.

Scope:

- Implement `createWorkflowSqsHandlers` for one exact consumer/source/DLQ binding. Validate
  the complete bounded batch, queue ARN and outer/inner event identity before markers or
  effects. Reuse legacy adapter mechanics only after strict validation/authorization.
- Implement the versioned bounded routing document and `/local` exports for parsing,
  guarded dummy-credential clients and workflow creation. Reject inherited AWS settings,
  arbitrary endpoints, incorrect function context and mismatched workflow/profile identity.
- Enforce final destination guards for host/Lambda endpoints. Invalid configuration fails
  before SDK requests; valid routing still requires owned local-resource checks before
  business access. Binding data contains no token/credential material.
- Add compiled JS/declarations, explicit workspace source aliases and isolated import
  coverage for the intentional subpath. No private lab dependency or startup I/O.

Acceptance: invalid batches/recovery envelopes cannot be acknowledged through existing
markers; safe host/Lambda runtime factories use identical semantics. Ordinary legacy SQS
behavior and imports remain unchanged unless opting into the new binding.

Verification: complete-batch/pre-marker/forged-recovery tests, no-network import/unsafe
configuration probes, endpoint/final-transport tests and clean package/generated/bundle
checks using compiled public exports as well as workspace unit-test aliases.

## Phase 7: Opt-In Collector Infrastructure

Depends on: Phase 6.

Goal: remove custom collector topology without changing infrastructure for ordinary users.

Scope:

- Add the design's opt-in recoverable-worker configuration and readonly named collector
  bindings. Validate that resources, subscriptions, bounds and manifest agree; do not
  introduce a second editable subscription list or positional grant assumptions.
- Compose one collector per worker DLQ, with bounded concurrency, timeouts, visibility,
  retention, receives and logs matching the reviewed local profile. Do not chain collectors.
- Reuse existing Content collector IDs/names where compatible. Expose grants through
  stable bindings so application-owned S3/jobs policy remains outside the framework.
- Keep a no-opt-in empty collector map and identical legacy resource/ID/policy topology.
  Document local bounds as tested limits, not production tuning or deployment evidence.

Acceptance: synthesized opt-in topology has least necessary supported grants/bindings;
no-opt-in snapshots show no new stores, queues, collectors, IDs or policies.

Verification: topology/assertion/snapshot tests, generated Work Requests synth/doctor,
Content comparison fixtures and clean release/package checks. No actual AWS deployment.

## Phase 8: Shared Lab Ownership and Lifecycle

Depends on: Phase 7.

Goal: extract the safety-critical lab shell into app-neutral private tooling.

Scope:

- Introduce private `tooling/local-lab`, workspace/root filters, unit tests and public-local
  transport consumption. Public runtime packages must not depend on this tooling.
- Extract bounded profile/manifest parsing, owner tags/mapping preflight, readiness,
  immutable profile/archive identity and exact Docker/container/network cleanup.
- Move working startup/down orchestration and finite deletion support; test app-neutral
  profiles and foreign-owner refusal. Keep destructive safeguards before mutation.
- Preserve the pinned image/digest and explicit Hobby/token startup boundary. Implement
  old Content manifest decoding only for safe owned teardown, not adoption or upgrade.
- Let the current Content launcher delegate completed lifecycle operations while its
  remaining provisioning/reset path is explicitly transitional until Phase 9. Shared
  code never imports that app. Do not expose unimplemented lifecycle commands.

Acceptance: up/down work for an isolated profile, including matching warm runtime removal,
without deleting unrelated resources or needing a token to tear down. Bad/foreign manifests
fail before mutation. The interactive review lab remains untouched.

Verification: credential-free ownership/lifecycle/transport tests and root filter checks;
an actual isolated start/down cycle, owned-orphan cleanup, foreign-lookalike refusal and
sanitized evidence. Existing app lifecycle/regression tests remain valid.

## Phase 9: Finite Providers and Content Lab Migration

Depends on: Phase 8.

Goal: make supported consumers declarative lab profiles rather than copied SDK provisioners.

Scope:

- Extract the existing finite DynamoDB/stream, EventBridge, SQS, Lambda, role/log providers
  plus Content's S3/Scheduler extras. No arbitrary SDK/shell callbacks or infrastructure DSL.
- Complete provision/reset, dependency ordering, pagination/readiness and verification of
  mapping/owner/config/archive identity. Emit versioned routing data only after success.
- Convert Content infrastructure inputs to pure app profile/assets/service grants, with
  thin command launchers. Preserve the app's actual proof scenarios/assertions rather than
  moving domain tests into the generic lab package.
- Enforce explicit token-file selection for future Report startup; never discover another
  app's credentials. Keep old-manifest support down-only and require fresh owned creation.
- Remove replaced Content lifecycle/provider algorithms; document profile registration
  and cleanup. Do not implement Report-specific providers or collectors later.

Acceptance: the existing Content runtime provisions and runs through shared providers;
sentinel-safe reset, reprovision and teardown work on a fresh isolated lab. The shared
package has no app import and new supported profile registration requires only data/assets.

Verification: provider failure/paging/ownership tests, unchanged Content local proof using
the current runtime, reset/reprovision workflow and exact teardown. Unit tests still need
no Docker/token. Shared tooling participates in root lint/typecheck/test/build checks.

## Phase 10: Content Command and Record Migration

Depends on: Phase 9.

Goal: delete app-owned scoped dispatch/transaction machinery without changing editorial policy.

Scope:

- Bind Content resource commands to shared memory/Dynamo workflow services. Replace
  transaction fragments and staging with registered receipt/publication-attempt records
  and pure contributions; preserve their schemas, keys, owners and domain validation.
- Keep capability/fixture authorization and the live publication claim-result validator
  in the app. Preserve frozen approvals, current-response fencing and existing API errors.
- Migrate one boundary at a time using thin delegating facades only where necessary.
  Keep the legacy delivery/recovery path as the sole active path until Phase 11: do not
  run two pumps, write two failure ledgers or activate duplicate consumers.
- Delete superseded command algorithms and update the frozen inventory's migration ledger
  without changing the baseline denominator or counting exclusions.

Acceptance: public command composition replaces both app adapter algorithms; legacy keys,
response metadata, equivalent/conflicting retries, receipt atomicity and stale-claim
rejection remain unchanged. Domain state is still the authority for publication.

Verification: both-adapter command/record/golden suites, all Content unit/API tests,
memory browser suite with desktop/mobile inspection, clean release regressions and a real
local command/stream happy path through the transitional single delivery owner.

## Phase 11: Content Delivery and Recovery Migration

Depends on: Phase 10.

Goal: retire the selected app-owned recovery/pump machinery while preserving full behavior.

Scope:

- Bind domain handlers and the publication reconciler to shared delivery/operations;
  replace app failure stores, replay coordination, memory pump and AWS wrapper algorithms.
- Retain operator authorization, DTO validation, publication eligibility/fences and explicit
  editor retry. Generic publisher-envelope replay remains forbidden, including stale rows.
- Use opt-in CDK collector composition and manifest-derived local consumer wiring. Keep
  application S3/jobs grants and the one existing HTTP/minute-job scheduling arrangement;
  never start a second memory processing loop.
- Remove now-unused facades, duplicated subscriptions and selected generic implementations.
  Preserve immutable artifact/upload/notification/recurring-job code and existing assertions.
- Update current Content recipes and migration/compatibility evidence.

Acceptance: the consumer maintains its existing unit/API/workbench behavior using public
command, delivery and recovery composition. Interrupted collection, live claim deferral,
unauthorized replay, completion races and duplicate delivery do not weaken business authority.

Verification: all Content unit/memory browser suites and clean release checks; real local
browser workflow plus the complete normal-bound failure/reset/reprovision/teardown gate
against migrated bundles. Record archive/profile identities and cleanup, not prior passes.

## Phase 12: Independent Report Runs Consumer

Depends on: Phase 11.

Goal: demonstrate a useful, small async application built from the new public contracts.

Scope:

- Add private headless `apps/report-runs` with strict bounded inventory input, deterministic
  sorting/JSON bytes/digest and stored result export. Validate predicted size before commit.
- Implement request and internal completion resource commands plus one bound worker.
  Strong-read completion and deterministic business identity must converge after lost
  acknowledgements or marker expiry, without a new claim/lease subsystem.
- Implement the specified loopback HTTP API and thin CLI request/status/result/failures/
  replay commands, fixture permissions, bounded ingress, structured errors and graceful
  close. All exposed commands/routes work; no Angular, S3, Scheduler or fault-control route.
- Compose memory/local runtimes, real worker/collector bundles, explicit fixtures/seed,
  minimal shared lab profile and CDK synthesis. No custom transaction/collector/pump/provider
  algorithms and no Content/private-package/deep imports in installed runtime code.
- Document actual memory and local operation, result retrieval, recovery authorization,
  fixture-auth limitations and tested service limits. Keep proposed options unadvertised.

Acceptance: request -> async worker -> durable result -> verified export works in memory
and through the real local stream/bus/queue/Lambda path. Completion duplicates produce one
logical result/version/fact. Requester/operator boundaries and bounded validation hold.

Verification: domain/golden bytes/digest/Unicode/size tests, HTTP/CLI end-to-end and memory
failure/replay tests, public import/bundle/synth checks, clean release and actual local
happy path with owned teardown. Full live fault matrix is the next dedicated gate.

## Phase 13: Independent Installation and Functional Candidate

Depends on: Phase 12.

Goal: establish complete functional evidence before measuring the post-extraction tasks.

Scope:

- Implement `scripts/verify-installed-workflow.mjs`: pack public tarballs and install a
  source/config-only Report composition outside the workspace using explicit tarball
  overrides for unpublished versions. Do not use workspace directories, source aliases,
  prebuilt consumer outputs, private lab dependencies or implicit unpublished npm fetches.
- Verify installed types/exports, memory request/worker/result/recovery and actual AWS
  worker/collector bundle build/import. Assert resolution remains inside the project and
  imports do not create clients or make requests.
- Complete Report's full live HTTP/CLI fault gate: automatic transient retries, three
  terminal receives, actual redrive, interrupted collector retry, authorized targeted
  replay, crash after completion before marking and marker-loss duplicates.
- Use verification-only dependency/lifecycle hooks on normal factories; no production
  env-controlled fault readers. Check ownership/archive identity before swaps and restore
  standard bundles in `finally`; restoration failure remains a failed/no-go result.
- Run final Content memory/local browser and full deployed failure gates, then Report's
  gate sequentially, including both profiles' zero-network negatives, foreign refusal,
  sentinel-safe reset, reprovisioned workflow and complete owned teardown.
- Extend existing PR/manual CI and root release coverage, retaining protected cloud
  boundaries, finite step/job deadlines and the fifty-minute cloud-job ceiling. Split
  bounded jobs if necessary, do not add push triggers. Keep bounded sanitized artifacts
  (300 files/100 MiB, seven days), excluding env/manifests/raw logs. No remote dispatch/setup.
- Finish the public recipes used by post-task agents and freeze reviewed candidate source,
  lock/doc/profile/archive hashes. Record evidence without creating a commit automatically.

Acceptance: AC-01 through AC-06 and AC-09 through AC-11 have actual functional evidence,
including installed packages and both real service compositions. No host-pump/direct-call/
accelerated-visibility substitute or prior archive pass is accepted. Post exercises are
still separately required; functional success is not yet a positive leverage verdict.

Verification: pristine frozen-install tests-before-build full release/generated/browser/
package/boundary checks, isolated installed-report gate and both complete live matrices.
Verify evidence bounds/redaction and cleanup. Any failed/not-run required gate prevents
the functional-candidate freeze until resolved or the scope is explicitly reviewed.

## Phase 14: Leverage Verdict and Acceptance Audit

Depends on: Phase 13 and actual reviewed post A/B observations.

Goal: decide whether this iteration made JawStack a better development accelerator.

Scope:

- Run the frozen structural counter on all relevant post-migration consumer locations,
  including renamed/generated code and replacement composition, not only old filenames.
  Explain remaining generic code and check `1 - post / baseline >= 0.50`.
- Disclose framework source growth, public adapter/user export/concept growth, both apps'
  integration/configuration footprint and retained domain code. Audit dependencies and
  imports for copied protocols, app-to-app coupling, deep imports and private lab leakage.
- Compare baseline/post task equivalence, generic integration churn, correction rounds,
  private-source needs and observed effort. Include failed/partial attempts, unavailable
  tokens, settings changes and familiarity/hardware/network confounders. Do not infer a
  universal speed multiplier or a comparison with from-scratch AWS development.
- Write `outcome.md` and leverage results with separate functional, structural and paired
  exercise verdicts, AC-01 through AC-12 mapping, actual commands/source identities,
  exclusions and passed/failed/not-run outcomes. A negative/inconclusive leverage result
  is a no-go, not iteration acceptance or permission to relax tests/rerun until favorable.
- Consolidate public package/application recipes, local lab runbooks, architecture/service
  limits, compatibility notes and iteration indexes. Remove obsolete migration facades
  only if that cleanup does not invalidate frozen candidate/exercise evidence; otherwise
  review and rerun affected gates before claiming acceptance.
- Produce an uncommitted merge-readiness summary with residual risks. No publication,
  version bump, tag or real-AWS claim follows automatically from acceptance.

Acceptance: all required criteria are satisfied and leverage is positive with reviewed
evidence, or the outcome explicitly records a no-go and the iteration remains unaccepted
pending a scope decision. Never mark a failed/inconclusive product outcome complete merely
because this audit document is finished.

Verification: final clean release/installed checks and docs/link/import audits. Phase 13
live evidence may be reused only with exact unchanged runtime/profile/archive identities;
record that reuse instead of claiming a fresh run. Any relevant code/config change requires
affected live/browser/exercise reruns. Verify clean teardown and reviewable git diff.

## Acceptance Mapping

| PRD   | Owning phases/gates   | Required evidence                                                                                                         |
| ----- | --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| AC-01 | 2, 4-6, 10, 12-13     | Both adapters, scope/concurrency/expiry/ambiguous replay, both consumer compositions.                                     |
| AC-02 | 1-2, 5, 10; task A    | Ownership/bounds/projection/rollback parity and equivalent atomic-receipt exercises.                                      |
| AC-03 | 3-6, 11-13; task B    | Pre-marker authorization, interrupted collection, atomic bounded replay and live recovery.                                |
| AC-04 | 0, 10-11, 13          | Frozen compatibility fixtures; preserved Content unit/API/browser/full local assertions.                                  |
| AC-05 | 12-13                 | Real memory/local report processing/export, failures/recovery and completion duplicate proof.                             |
| AC-06 | 4, 6, 8-12, 14        | Public composition, finite shared lab profiles, import/dependency/copy audit.                                             |
| AC-07 | 0, 10-11, 14          | Frozen denominator, whole-consumer post accounting, >=50% reduction and disclosed framework/API growth.                   |
| AC-08 | Baseline/post A/B, 14 | Four fresh sessions, equivalent tests, no post framework edits, reduced generic integration work and honest observations. |
| AC-09 | 6, 12-13              | External tarball install, types/memory/recovery, actual AWS bundle/import and resolution assertions.                      |
| AC-10 | 4-7, 10-14            | Clean frozen install/tests-before-build, Work Requests/generated apps, package guard/dry runs and browser boundaries.     |
| AC-11 | 8-9, 11-13            | Both complete real-transport matrices, safe configuration/reset/reprovision and owned teardown.                           |
| AC-12 | 4-14                  | Current public/app/lab recipes, exact evidence/exclusions and reviewed outcome/leverage verdict.                          |

## Evidence Recording

Phase 0 observations are recorded in [its evidence log](phase-0-evidence.md) and the
[measurement packet](leverage/README.md); [Phase 1 evidence](phase-1-evidence.md) records
typed records/plan verification and growth. [Phase 2 evidence](phase-2-evidence.md) records
scoped execution, atomic memory persistence and its clean release gate.
[Phase 3 evidence](phase-3-evidence.md) records failure/recovery services, compatible
memory storage and verification. [Phase 4 evidence](phase-4-evidence.md) records public
memory composition, delivery/lifecycle, browser regression and installed-package proof.
Later phase evidence is not asserted. Update
individual phase statuses and append dated observations rather than marking every row
complete at the end. For each phase record:

- Source commit and relevant uncommitted patch identity; reviewed scope changes.
- Commands/tool versions and passed, failed or not-run results with reasons.
- Artifact/config/archive identity and exact scenario for any live/browser evidence.
- Ownership/reset/teardown outcome and whether the interactive environment was preserved.
- Remaining prerequisites, acceptance implications and the next permitted phase.

Store sanitized baseline/task/count results under `leverage/` when actually produced;
keep raw task patches/timing traces ignored. Link actual local evidence and the final
outcome when they exist. Do not add empty evidence files or use a planned command as proof.
