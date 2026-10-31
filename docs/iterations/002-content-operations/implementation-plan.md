# Iteration 2 Implementation Plan: Content Operations

Status: reviewed. Phases 0-11 are complete. Recoverable publication artifacts, memory workflow,
bundled SQS contracts, live DynamoDB/S3 recovery, and workspace regressions passed. Phase 12 is next.

## Purpose

Implement the [PRD](prd.md) and [technical design](technical-design.md) as focused phases,
each sized for one code -> user review -> user commit cycle. The agent implements and
verifies; the user reviews and commits. Do not automatically commit, push, merge, tag,
publish packages, or bump versions.

The deliverable is a useful content-operations consumer with verified local AWS integration
and narrowly motivated framework improvements. It is not a mandatory `v0.0.2` release.

This plan has 25 phases, numbered 0-24. Their number reflects review boundaries, not
product milestones or elapsed-time estimates. Split a phase before implementation if its
diff cannot be reviewed coherently; do not turn a phase into several unreviewed cycles.

## Execution Rules

- Read the current code and prior phase evidence before starting. Work with existing changes.
- Keep each phase buildable and testable. Add tests with the behavior they exercise; do not
  merge knowingly failing tests for features assigned to later phases.
- Implement consumer policy in `apps/content-operations`, reusable contracts in the owning
  packages, and lab/verification tooling at the narrowest useful ownership boundary.
- Consume public package exports. Do not copy Work Request logic, deep-import internals,
  use array positions for CDK grants, or introduce speculative modules.
- Preserve the generated Work Requests starter and existing public APIs unless an explicit
  reviewed contract change is necessary. Document compatibility and regression coverage.
- Default tests, builds, typechecks, imports, and configuration loading must not start Docker,
  need secrets, use cloud credentials, or issue AWS requests.
- Never add a no-op handler or success-shaped placeholder to claim a workflow is complete.
  Do not expose a UI control or HTTP route until its behavior is implemented and tested.
- Update phase status and record actual commands/results as work progresses. Distinguish
  passed, failed, and not-run checks; do not mark a whole group complete at the end.
- Keep documentation current within each phase. The final documentation phase consolidates
  and audits it; it does not postpone instructions required to run earlier work.

Commands and application paths below are implementation targets. Most app scripts do not
exist yet. Introduce them in their owning phases, not as empty placeholders in this docs change.

## Verification Levels

Every code phase runs focused tests plus relevant typecheck/lint/build checks and
`git diff --check`. Use the repository's `.nvmrc` and pinned pnpm. Documentation changes
also pass `pnpm format:check` and local Markdown link checks.

Framework phases run the affected package tests and relevant dependent-consumer tests.
After changing public contracts, run workspace typecheck/test/build, package guard, isolated
generated-app verification, and package dry runs. A passing workspace alias is not proof
that an installed package works.

Consumer phases run the app's credential-free suite and workspace regression tests. Run
LocalStack scenarios when they exercise a changed AWS boundary; make the particular
scenario and runtime explicit. Never substitute a mocked SDK test for integration evidence.

Browser phases run Playwright against real local servers and inspect desktop/mobile
screenshots. Final verification includes `pnpm verify:release`, the complete memory browser
suite, and the full local integration gate. These are separate gates: the existing release
script alone does not establish Iteration 2 acceptance.

## Feasibility Gate

Phases 0-1 are the two-phase LocalStack spike required by the design. Before running them,
verify a suitable container runtime, a user-provided LocalStack token, Hobby entitlement,
and acceptable local machine resources. Do not print the token, search credential stores
for one, activate a paid trial, or use a real AWS account as a fallback.

Documentation preparation does not execute the spike. During implementation, normal
explicit local commands may start the dedicated lab, but real-AWS deployment is outside
this plan and requires a separate decision.

Select and pin the actual emulator image during the spike and record its digest. Evidence
must identify the entitlement, host/container architecture, tested operations, exclusions,
durations, and cleanup result. A tokenless run is not a pass. Do not proceed to dependent
integration work without a passing gate; if a required service path fails, propose a scoped
design/PRD revision rather than silently emulating or bypassing it. Unrelated memory-only
work may proceed only after an explicit sequencing decision, without claiming the gate passed.

## Phase Index

| Phase | Primary Owner              | Deliverable                                               | Status   |
| ----- | -------------------------- | --------------------------------------------------------- | -------- |
| 0     | Consumer tooling           | Isolated lab and transactional event spine                | Complete |
| 1     | Consumer tooling           | S3, Scheduler, DLQ, teardown proof and gate decision      | Complete |
| 2     | Core                       | Paged query contracts and memory implementation           | Complete |
| 3     | AWS runtime                | DynamoDB paged query implementation                       | Complete |
| 4     | Angular                    | Browser-safe presentation contract and structured errors  | Complete |
| 5     | AWS CDK                    | Named worker/scheduler bindings                           | Complete |
| 6     | Consumer domain            | Draft and review aggregate                                | Complete |
| 7     | Consumer persistence       | Scoped dispatch, atomic operation records and projections | Complete |
| 8     | Consumer services          | Attachment lifecycle and verified object storage          | Complete |
| 9     | Consumer workers           | Materializers, notification sink and memory event pump    | Complete |
| 10    | Consumer domain            | Publication intent, claims and generation transitions     | Complete |
| 11    | Consumer workers           | Recoverable publication execution                         | Complete |
| 12    | Consumer jobs              | Due work, reminders, time zones and cleanup               | Planned  |
| 13    | Consumer operations        | Failure collection and bounded recovery                   | Planned  |
| 14    | Consumer API               | Loopback HTTP, bounded queries and typed routes           | Planned  |
| 15    | Consumer UI                | Workbench, drafting and browser boundary                  | Planned  |
| 16    | Consumer UI                | Review queue, frozen snapshots and activity               | Planned  |
| 17    | Consumer UI                | Attachments and publication preview                       | Planned  |
| 18    | Consumer UI                | Scheduling, calendar and agenda                           | Planned  |
| 19    | Consumer UI                | Operations, outcomes and retry controls                   | Planned  |
| 20    | Consumer AWS               | Actual app bundles and LocalStack runtime wiring          | Planned  |
| 21    | Consumer infrastructure    | CDK composition and topology assertions                   | Planned  |
| 22    | Integration verification   | Full local workflow, failure and isolation evidence       | Planned  |
| 23    | Browser/CI verification    | Complete browser acceptance and PR/manual gates           | Planned  |
| 24    | Documentation/verification | Acceptance audit and merge readiness                      | Planned  |

Follow this order by default. Later phases may reuse earlier services but must not depend
on unimplemented later UI, infrastructure, or tests. Keep implementation discoveries in
the design and phase log rather than quietly changing the acceptance criteria.

## Phase 0: Isolated Lab and Transactional Event Spine

Goal: prove a minimal real service path using existing public JawStack adapters.

Scope:

- Introduce the private `content-operations` workspace package with working typecheck,
  test, lint, and build scripts for the harness; no Angular shell or editorial model yet.
- Keep live scenarios outside default unit-test discovery from the outset, using explicit
  integration configuration/scripts rather than token-dependent `*.test.ts` files.
- Add strict runtime selection, dummy-credential SDK factories, host/container endpoint
  checks, outgoing transport guards, and credential-free negative tests.
- Add dedicated Compose startup/readiness and exact ownership manifests/cleanup for the
  resources created in this phase. Do not leave cleanup until the application is finished.
- Provision a table/stream, event bus, SQS queue, required policies/roles, bundled outbox
  dispatcher, and a minimal observable worker through SDK calls and direct ZIP uploads.
- Execute a small test resource command through scoped DynamoDB persistence, then observe
  its real stream -> dispatcher -> EventBridge -> SQS -> Lambda outcome.

Out of scope: new framework APIs, editorial features, paid CDK asset deployment, and AWS deploys.

Acceptance:

- Negative configurations fail before a transport request; imports/default tests need no Docker/token.
- A command atomically stores state/activity/projection/idempotency/outbox and reaches the
  bundled worker without a direct worker call or manually published replacement event.
- Startup/readiness, image pin, topology, result, and cleanup are recorded in a nonempty
  `localstack-evidence.md`; missing prerequisites or failed paths are reported accurately.

Verification: harness unit/transport tests, workspace checks, explicit spine scenario,
and a teardown/restart of the owned lab. Status remains incomplete if the live proof cannot run.

## Phase 1: Storage, Scheduling, DLQ, and Gate Decision

Depends on: Phase 0.

Scope:

- Extend the same harness with private S3 conditional creation/readback and duplicate handling.
- Provision a Scheduler target and observe at least one automatic rate-triggered invocation.
- Inject a worker failure, observe actual queue redrive to a DLQ, and persist its outcome
  through a minimal failure collector before acknowledging the DLQ message.
- Verify host/Lambda networking, SQS URL validation, bounded retries/timeouts, and ownership-safe
  reset/teardown, including spawned Lambda containers and an unrelated-resource sentinel.
- Record Hobby entitlement, exact image/architecture, CDK/API Gateway and Scheduler fidelity
  exclusions, complete pass/fail/not-run results, and the go/no-go decision.

Out of scope: the finished publication protocol, application UI, and a generic provisioner.

Acceptance:

- All six feasibility checks in the technical design have observed results on the pinned image.
- Duplicate S3 writes converge, the automatic scheduler outcome is distinct from a manual trigger,
  failed messages are retained durably, and cleanup leaves the unrelated sentinel untouched.
- A failed critical check stops dependent work for explicit design review; a passing harness
  becomes the foundation of later app verification rather than a disconnected throwaway demo.

Verification: full harness scenarios, negative/cleanup tests, and reviewed evidence. This
phase's live gate cannot be replaced by unit tests or a successful paid trial.

## Phase 2: Core Paged Queries

Depends on: passing feasibility gate, unless sequencing is explicitly revised.

Scope:

- Add public `Page`, `ProjectionQuery`, `ActivityQuery`, and query-repository contracts.
- Implement memory projection/activity paging with the designed ordering, range bounds,
  page limits, direction, and continuation semantics.
- Validate versioned cursor structure and query scope without exposing a raw database API.
- Keep existing array-returning methods and command/resource contracts compatible.

Acceptance:

- Tests cover tied timestamps, empty pages, invalid/reused cursors, deleted continuation
  items, ascending/descending reads, and exact range boundaries without gaps or duplicates.
- Existing core and Work Requests tests pass; types are available from public exports.

Verification: core tests, typecheck/build, dependent tests, and the public-contract regression gate.

## Phase 3: DynamoDB Paged Queries

Depends on: Phase 2.

Scope:

- Implement `queryProjection` and `queryActivity` using public keys/mappers and DynamoDB Query.
- Preserve `LastEvaluatedKey` and validate partition/range/direction on continuation.
- Share query contract cases with memory; keep filtering budgets in the consumer layer.
- Extend the live harness with a multi-page dataset and projection-sort movement checks.

Acceptance:

- SDK contract tests and LocalStack reads agree with memory on ordering and continuation.
- No method silently truncates the new paged contract or reads an arbitrary caller-supplied key.
- Existing adapters, generated app, and package verification remain working.

Verification: AWS runtime tests, shared contract cases, live paging scenario, and public-contract gate.

## Phase 4: Angular Presentation Metadata and Errors

Depends on: Phase 3; no consumer UI prerequisite.

Scope:

- Export `ResourceUiDefinition` with presentation fields and command schemas but no executor.
- Narrow component/config inputs to that structural contract while retaining assignment
  compatibility with existing full resource definitions.
- Export `JawStackApiError` carrying code/status/details/correlation ID and use it in the
  default fetch client without breaking normal `Error` handling.
- Add presentation-only component tests and regression tests for existing definitions/errors.

Acceptance:

- Components accept metadata without fake `decide` functions or server imports.
- HTTP conflict/permission errors are distinguishable without parsing English messages.
- Existing Angular tests, demo build, and isolated generated-app build still pass.

Verification: Angular component tests, library build, consumer builds, and public-contract gate.

## Phase 5: Named CDK Bindings

Depends on: Phase 4.

Scope:

- Expose `workerBindingsByName` and `schedulerFunctionsByName` as readonly records.
- Include worker function, queue, and DLQ in each worker binding; reject duplicate names.
- Preserve existing props, arrays, logical IDs, and baseline topology.
- Test adding application-owned grants/collectors through public bindings, not tree inspection.

Acceptance:

- Bindings resolve the correct declared names and missing/duplicate cases fail clearly.
- Synth assertions demonstrate targeted S3 grants and scheduler write grants without AWS requests.
- Existing CDK and generated-app synthesis tests pass unchanged in behavior.

Verification: CDK tests/synth and public-contract gate. No deployment is performed.

## Phase 6: Draft and Review Aggregate

Depends on: Phases 2-5.

Scope:

- Define complete Zod state/input/event schemas, fixture identities, payload bounds,
  presentation metadata, and pure resource factories for content and review tasks.
- Implement create/edit, submit, approve, request changes, reopen, and eligible archive decisions.
- Make content authoritative; distinguish resource version, revision ID, and review ID.
- Emit complete immutable review snapshots and projection plans for later materialization.
- Test decisions through `executeCommand` with memory persistence; keep config/imports side-effect free.

Out of scope: asset bytes, publication execution, HTTP, and UI.

Acceptance:

- Ownership, editor-only actions, invalid transitions, expected-version conflicts, stale
  approvals, payload limits, and frozen snapshots have executable tests.
- Review resources cannot independently authorize an editorial decision, and no Work Request helper is used.

Verification: consumer domain tests, app typecheck/lint/build, and workspace regression tests.

## Phase 7: Scoped Dispatch and Atomic Persistence

Depends on: Phase 6.

Scope:

- Implement invocation-scoped memory/DynamoDB repositories and dispatch/unit-of-work factories.
- Add logical idempotency expiry, matching command/subject scope, and concurrent replay handling.
- Compose public transaction builders with bounded app operation records and equivalent atomic
  memory behavior; preserve primary version/idempotency checks.
- Implement old-key deletion/new-key insertion for projection moves, action deduplication,
  and the 60-action application transaction budget.

Acceptance:

- Tests prove rollback, concurrent equivalent replay returning the stored response, conflicting
  reuse rejection, distinct subject/command scopes, expiry, and no shared mutable request scope.
- Projection moves behave identically across adapters and do not retain stale rows or issue
  two transaction actions on the same physical key.

Verification: memory/SDK contract tests, scoped live transaction scenario, and workspace regressions.

## Phase 8: Attachment Lifecycle and Object Store

Depends on: Phase 7.

Scope:

- Implement bounded content-owned attachment slots and asset snapshot schemas/resource factory.
- Add registration, internal verified completion, removal/expiry, revision invalidation,
  and ready-only submission rules.
- Implement memory and guarded S3 object-store adapters with generated keys, conditional
  creation, digest/readback, limits, and PNG/JPEG/PDF signature detection.
- Add a transport-independent bounded upload service; HTTP routing follows in Phase 14.

Acceptance:

- Interrupt/retry, duplicate/different bytes, oversize/wrong type, malicious filenames,
  cross-content IDs, and removal/completion/submission races are tested.
- Only trusted verification can mark a slot ready; approved object references cannot be overwritten/deleted.

Verification: upload/domain adapter contracts, focused live S3 scenario, and app/workspace checks.

## Phase 9: Materializers, Notification Sink, and Memory Pump

Depends on: Phase 8.

Scope:

- Implement review/asset snapshot application with source-version checks, tombstones,
  optimistic retries, and complete out-of-order upserts.
- Implement the durable local notification sink with stable delivery IDs and atomic query records.
- Add the explicit memory outbox pump, shared event handlers, bounded processing/retry state,
  and deterministic clock/drain hooks without emulating AWS infrastructure.
- Register only implemented subscriptions; retain correlation/causation and validate source/payloads.

Acceptance:

- A completed review arriving before its opening event cannot become pending again; a removed
  asset cannot be resurrected by late events.
- Concurrent/late duplicate notification events produce one visible sink delivery, including
  after transport-marker expiry; materializer outputs do not create event loops.
- A memory draft/review/attachment workflow has observable related resources and notifications.

Verification: worker and memory-flow tests, notification atomicity tests, and workspace regressions.

## Phase 10: Publication Intent and Execution State

Depends on: Phase 9.

Scope:

- Implement schedule/reschedule/cancel, publish-now/due-request, claim, completion/failure,
  and explicit retry decisions with strict actor/internal-command rules.
- Freeze approved publication identity/snapshot/timestamp; separate generations and attempt IDs.
- Add lease/fencing state, atomic operation history, and publishing locks against editorial mutation.
- Test state transitions with an injected clock before adding external writes.

Acceptance:

- Schedule/reopen/cancel races have one authoritative winner; stale generations cannot publish.
- Lease expiry does not unlock editing, and stale attempts cannot complete/fail a newer claim.
- Retry keys do not replay an expired claim indefinitely; explicit retry preserves artifact identity.

Verification: domain/concurrency/lease tests and app/workspace checks. No publication handler is
exposed as complete until Phase 11 supplies actual object execution.

## Phase 11: Recoverable Publication Worker

Depends on: Phase 10.

Scope:

- Implement stable schema-versioned JSON serialization/digest and the claim -> conditional
  write/verify -> completion protocol using both object-store adapters.
- Register the shared publisher in the memory pump and a bundled SQS entrypoint using the
  framework adapter; mark processing complete only after the domain commit.
- Persist attempt outcomes and emit success/terminal-outcome facts without direct provider calls.
- Add exact-operation failure injection for tests, not a user-accessible failure endpoint.

Acceptance:

- Concurrent duplicates and a crash after object creation recover to one logical publication.
- Existing matching artifacts recover; mismatched digests fail visibly without overwrite.
- In-progress competing claims retry rather than acknowledging the event as successfully processed.

Verification: worker crash/lease/marker-gap tests, memory publish flow, and focused live artifact scenario.

## Phase 12: Due Work, Reminders, Time Zones, and Cleanup

Depends on: Phase 11.

Scope:

- Implement recurring due-publication/review jobs with authoritative rereads, generation checks,
  fixed-cutoff checkpoint cursors, short job leases, and per-tick work/time budgets.
- Add one-reminder-per-review-per-UTC-day policy and notification emission in the same commit.
- Add explicit-offset UTC input validation and Temporal local-time conversion/disambiguation.
- Implement bounded slot expiry and old-orphan cleanup using authoritative state, preserving
  approved/published objects and tombstones until safe removal.

Acceptance:

- Repeated/overlapping ticks do not duplicate publication or reminders, and a failing old
  item cannot starve later work across checkpointed passes.
- DST gaps/folds, stale schedules, stopped/restarted clocks, upload expiry, and safe orphan
  deletion have tests; cleanup never trusts an asset read model alone.

Verification: fake-clock/domain/job tests, object cleanup contracts, and workspace regressions.

## Phase 13: Failure Collection and Bounded Recovery

Depends on: Phase 12.

Scope:

- Implement durable failed-delivery records and the shared DLQ collector, including safe
  repeated collection and live/stale publication-claim reconciliation.
- Implement editor publication retry and `jobs:inspect` / `jobs:replay` for allowlisted failures.
- Persist recovery state plus outbox atomically, enforce three manual cycles, and preserve
  original event/business identity while assigning a fresh transport ID.
- Implement memory failure/recovery behavior with the same policies and bounded retention.

Acceptance:

- No DLQ message is acknowledged before durable collection and applicable state reconciliation.
- Late failures cannot replace a newer success; a collector retry completes partially
  recorded work rather than skipping necessary reconciliation.
- Crash/replay and marker-expiry tests preserve one logical artifact/delivery; arbitrary payloads,
  queue URLs, consumers, and exhausted recovery cycles are rejected.

Verification: collector/recovery tests, memory terminal-failure walkthrough, and app/workspace checks.

## Phase 14: Loopback HTTP and Bounded Application Queries

Depends on: Phase 13.

Scope:

- Implement the app Node router, fixed fixture resolution, command allowlist, internal-command
  exclusion, scoped dispatch, envelope/error mapping, Host/Origin checks, and size limits.
- Add typed content/review/calendar/operations queries, safe cursor/filter composition,
  paging budgets, and paged resource/activity reads.
- Wire upload/download and committed publication preview routes to actual services.
- Add `dev:api`, explicit runtime entrypoints, deterministic `seed`, health/manifest/fixtures,
  and API documentation; no Angular screens in this phase.

Acceptance:

- An HTTP-only memory walkthrough creates, uploads, reviews, schedules/publishes, and inspects results.
- Forged role/subject headers and internal command names fail; stale edits return structured
  conflicts; private downloads validate authoritative references and never expose raw storage configuration.
- Empty filtered pages retain continuation, filters cannot choose partitions, and query/JSON/upload limits hold.

Verification: loopback API integration tests with managed server shutdown, query budget tests,
config side-effect tests, app build, and workspace regressions.

## Phase 15: Workbench and Draft Editor

Depends on: Phase 14 and Angular contract from Phase 4.

Scope:

- Add the Angular/Vite shell, safe presentation metadata, typed application client,
  fixture selector, and same-origin API proxy on the designated loopback ports.
- Implement the real content board/list, create/detail/draft editing, URL filters and paging,
  version-aware submission, unsaved-edit handling, and meaningful loading/error/empty states.
- Introduce isolated Playwright setup and module-graph/browser-boundary verification;
  exclude browser specs from unit discovery immediately, not at the final CI phase.
- Add navigation destinations only as their screens become functional in later phases.

Acceptance:

- Author fixtures can create/edit their own draft; unauthorized/stale edits do not silently overwrite data.
- Client builds need no Node HTTP shim, server resource factories, AWS SDK, or CDK imports.
- Browser tests exercise real API-backed state at desktop/mobile widths and leave no test servers running.

Verification: component/client tests, memory browser smoke/screenshots, bundle boundary check,
app build, and workspace checks. Start the local dev servers and report their URLs for review.

## Phase 16: Review Queue, Snapshots, and Activity

Depends on: Phase 15.

Scope:

- Implement submission/editor selection, review queue assignment/overdue filters, and linked detail navigation.
- Show immutable submitted snapshots and editor approve/request-change forms with decision notes.
- Add the paged activity view, materialization-pending state, and permission/conflict feedback.
- Keep decisions routed to content authority, not directly to review read-model mutation.

Acceptance:

- Browser tests complete author -> editor -> changes requested -> resubmission -> approval.
- A stale review page cannot approve a reopened/new revision; history remains accessible and paginated.
- Keyboard focus and narrow-screen layouts are verified with actual workflow data.

Verification: component tests, expanded Playwright flow/screenshots, app build, and workspace checks.

## Phase 17: Attachment UI and Publication Preview

Depends on: Phase 16.

Scope:

- Add upload registration/progress/retry/removal controls and real image thumbnails/PDF downloads.
- Show authoritative pending/ready/error states without treating an eventual asset row as permission.
- Add publish-now outcome and committed snapshot preview/download using actual stored artifacts.
- Test accessible file controls, malicious names, interrupted transfer feedback, and conflict preservation.

Acceptance:

- The browser uploads a valid fixture, previews/downloads it, and publishes approved content with usable references.
- Invalid/oversize files fail clearly; failed uploads are never presented as ready; published assets remain read-only.
- No fabricated thumbnail, static publication result, or executable inline document substitutes for real behavior.

Verification: upload/preview component and browser tests, desktop/mobile checks, and app/workspace builds.

## Phase 18: Scheduling, Calendar, and Agenda

Depends on: Phase 17.

Scope:

- Add schedule/reschedule/cancel/reopen controls with explicit time-zone and future-time validation.
- Implement month-grid/agenda views, URL date/zone state, bounded-range queries, and detail navigation.
- Surface publishing locks, pending outcomes, and invalid/stale schedule conflicts.
- Use the implemented due jobs; do not put a separate publication timer in the browser.

Acceptance:

- Browser tests schedule an item and observe publication, then prove cancel/reschedule invalidates old work.
- DST-ambiguous input is rejected rather than silently shifted; calendar/agenda agree on displayed instants.
- All actions work by ordinary keyboard-accessible controls without mandatory drag/drop.

Verification: time/form/component tests, calendar browser scenarios/screenshots, and app/workspace checks.

## Phase 19: Operations and Recovery UI

Depends on: Phase 18.

Scope:

- Implement paged publication attempts, notification deliveries, and failure views with correlation detail.
- Add eligible editor publication retry controls, stalled/live-lease distinctions, and clear recovery limits.
- Implement the designed visibility-aware polling/backoff and preserve idempotency on network retries.
- Link operational outcomes back to content/review history; keep development-only replay in its CLI.

Acceptance:

- Browser tests show queued/running/success/failure/stalled states from real memory runtime data.
- A terminally failed publication can be explicitly retried without duplicating the artifact;
  forbidden/ineligible actions remain rejected by the server even when invoked outside the UI.
- Polling stops when hidden/settled and does not leak timers after navigation.

Verification: polling/client/component tests, recovery browser walkthrough, screenshots, and app/workspace checks.

## Phase 20: Actual Application AWS Runtime

Depends on: Phase 19 and the passing feasibility harness.

Scope:

- Bind the app's scoped persistence, operations, objects, internal identities, shared handlers,
  outbox adapters, Scheduler targets, workers, and collectors to guarded AWS clients.
- Build the actual app Lambda bundles and extend the existing SDK provisioner to their declared topology.
- Replace minimal harness payloads with real application scenarios while retaining the proven spine assertions.
- Add `dev:api:local`, update `local:provision`/seed/reset/down ownership behavior, and document runtime differences.

Acceptance:

- The same app HTTP/UI can target LocalStack without domain/UI code changes or an AWS endpoint fallback.
- Register all declared handlers, grants/policies, queues, schedules, S3 references, and log retention;
  no missing handler becomes a no-op or a direct host-side replacement for a Lambda.
- A real content command materializes related resources and reaches the actual publisher/notification consumers.

Verification: bundle/import tests, live app happy path plus cleanup, negative transport tests,
app build, and workspace regressions. Do not call CDK deployment or authorize real AWS mode.

## Phase 21: Application CDK Composition

Depends on: Phase 20 and named bindings from Phase 5.

Scope:

- Compose `JawStackResourceWorkflowApp`, private S3 storage, named worker grants, due-job
  write grants, collectors, and the synthesis-only JSON ingress wrapper.
- Use one infrastructure profile to compare supported lab topology/configuration with synth.
- Keep fixture auth visibly `dev`, reject non-local execution, and make configuration/synth side-effect free.
- Document explicit differences: local HTTP ingress, SDK provisioning, batching/architecture where
  applicable, absent IAM enforcement proof, and no real CloudFormation deployment.

Acceptance:

- Synth assertions demonstrate expected events/queues/DLQs/schedules, targeted object grants,
  explicit bounds, and no construct-tree or array-index dependencies.
- Baseline construct IDs/behavior and the generated Work Requests path remain intact.
- No app deploy command or misleading production-auth claim is introduced.

Verification: app/CDK synth tests, public-contract regression gate, and topology comparison.

## Phase 22: Full Local Integration and Failure Evidence

Depends on: Phases 20-21.

Scope:

- Complete `verify:local` against the real app workflow, uploaded object, review materialization,
  scheduled publication, notification sink, and paged operational queries.
- Add duplicate/out-of-order delivery, transient failure, terminal DLQ/collector failure,
  explicit recovery, object-write crash, lease expiry, and obsolete-generation scenarios.
- Prove unsafe endpoints/credential inheritance yield zero AWS requests, and verify missing-service errors.
- Repeat ownership-safe reset/teardown and update image/entitlement/architecture evidence with final results.

Acceptance:

- Verify authoritative state plus artifact/delivery counts, not just successful HTTP/PutEvents responses.
- Observe at least one automatic Scheduler tick; report manually triggered diagnostic tests separately.
- The final service path uses real streams/bus/queues/bundled Lambdas; it does not depend on
  paid plan features, direct substitute calls, or fabricated cloud evidence.
- All required scenarios have bounded deadlines, useful redacted diagnostics, and verified cleanup.

Verification: full local integration gate with recorded results. If the token/runtime is
unavailable, leave the gate not run and do not declare the iteration complete.

## Phase 23: Browser Acceptance and CI Gates

Depends on: Phase 22.

Scope:

- Consolidate Playwright acceptance across all five views, distinct fixtures, normal and failure workflows.
- Verify desktop/mobile screenshots, keyboard/focus behavior, preserved navigation state,
  no text overlap, and real image/artifact rendering.
- Add the credential-free memory browser gate to PR verification and an isolated manual or
  explicitly enabled trusted-PR LocalStack job with bounded artifacts/timeouts.
- Exclude integration/browser files from default unit discovery and prevent secret use in untrusted fork code.

Acceptance:

- Memory browser checks run without Docker/tokens; the browser scenario can also target the verified local lab.
- CI has PR/manual triggers only, no `push` trigger or unsafe `pull_request_target` execution.
- Missing integration credentials are reported as not run, never as a successful integration gate.
- Unit tests and browser runs terminate their managed processes and produce bounded failure diagnostics.

Verification: browser suite/boundary checks, workflow configuration review, default workspace
tests without secrets, and explicit integration-job evidence when configured.

## Phase 24: Documentation and Merge Readiness

Depends on: Phase 23 and successful local integration evidence.

Scope:

- Finalize app README, architecture/mode guide, setup/fixtures/walkthrough, service matrix,
  safety controls, limits, cleanup, troubleshooting, and recovery instructions.
- Update product/package docs for implemented public contracts without rewriting foundation history.
- Create an iteration outcome summary mapping every acceptance criterion to commands/tests/evidence,
  listing delivered consumer behavior, framework changes, gaps, and unperformed AWS checks.
- Run the complete verification gates from a clean install/build context; address release-blocking
  regressions before handing the diff to the user.
- Assess whether a future framework release is justified, without preparing one implicitly.

Acceptance:

- A developer can follow the documented memory workflow and the separately provisioned Hobby workflow.
- `pnpm verify:release`, the memory browser suite/bundle boundary check, and final
  `verify:local` evidence pass; links/format/diff checks pass and known exclusions are explicit.
- No versions, tags, npm publication, or real-AWS deployment are added merely to finish the iteration.
- Work is left uncommitted for user review; the summary does not confuse merge readiness with release authorization.

Verification: full workspace/generated-app/package checks, browser checks, recorded live
integration gate, documentation walkthrough, local links, and `git diff --check`.

## Acceptance Coverage

| PRD Criterion | Primary Implementation Phases | Final Evidence                                                                         |
| ------------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| AC-01         | 6-19                          | Seeded memory browser walkthrough and app README.                                      |
| AC-02         | 6-9, 14, 20                   | Three public-resource read/command paths, typed queries, and related-resource results. |
| AC-03         | 6-10, 14, 16                  | Ownership/version/review races, atomic commit contracts, and stale-page browser tests. |
| AC-04         | 8-12, 17-20                   | Uploaded asset, approved snapshot, due job, actual artifact, and notification.         |
| AC-05         | 10-12, 18, 22                 | Reopen/cancel/reschedule and delayed-generation tests across adapters.                 |
| AC-06         | 0-1, 20-22                    | Hobby evidence for real transaction/stream/bus/SQS/Lambda/S3/Scheduler behavior.       |
| AC-07         | 9-13, 19, 22                  | Duplicate/crash/failure/DLQ/replay outcomes and artifact/delivery counts.              |
| AC-08         | 0-1, 8, 12, 20-22             | Zero-request negative transport tests and ownership-safe cleanup/sentinel evidence.    |
| AC-09         | 14-19, 23                     | Five working views, keyboard states, paging, and desktop/mobile screenshots.           |
| AC-10         | 2-5, throughout, 21, 24       | Existing consumer, public API, generated-app, and package regression gates.            |
| AC-11         | Throughout, 22, 24            | Current docs, explicit service exclusions, recorded results, and iteration outcome.    |

## Phase Evidence Log

### Phase 0: October 31, 2026

- Implemented the private consumer harness, pure proof resource, guarded SDK clients,
  pinned Compose lab, explicit SDK provisioning, scoped command dispatch, receipt worker,
  ownership-preflight reset, and teardown/restart commands.
- App typecheck, lint, build, and 31 credential-free tests passed. The real transactional
  stream -> EventBridge -> SQS -> Lambda proof passed, including command replay and
  strongly checked records. Reset/reprovision and full teardown/restart proofs passed.
- Recorded observed image, architecture, user-attested Hobby tier, timings, topology,
  safety checks, and exclusions in [LocalStack Evidence](localstack-evidence.md).
- `pnpm verify:release` passed: formatting, workspace typecheck, all 149 unit tests, lint,
  builds, pkg-guard (zero findings), isolated generated-app verification, and six package
  dry runs. Local Markdown links and `git diff --check` passed. Final owned containers and
  network were confirmed absent after teardown.
- Phase 1 S3/Scheduler/DLQ and live sentinel checks remain not run. No real AWS, package
  release/version change, or automatic commit was performed.

### Phase 1: October 31, 2026

- Extended the pinned SDK-provisioned lab with private conditional S3 artifacts, a real
  recurring Scheduler target, source-queue redrive/DLQ, and a durable failure collector.
- Complete live gate passed twice, including automatic scheduling, exactly three failing
  receives, durable collection/acknowledgement, unrelated-owner sentinel survival,
  zero old Lambda containers after reset, and reprovisioned event/S3 proof.
- Added reset consent and running/passed/failed gate evidence; decision is `go` with
  explicit IAM/deployment/Scheduler-retry exclusions. App unit suite now has 42 passing tests.
- `pnpm verify:release` passed: formatting, workspace typecheck, all 160 unit tests, lint,
  builds, pkg-guard (zero findings), isolated generated-app verification, and six package
  dry runs. Local Markdown links and `git diff --check` passed. Final owned containers and
  network were confirmed absent after teardown. No subsequent phase has started.
- No public framework contract, package version, release, real AWS deployment, or commit
  was changed/performed. Details are in [LocalStack Evidence](localstack-evidence.md).

### Phase 2: October 31, 2026

- Added public `Page`, `ProjectionQuery`, `ActivityQuery`, and standalone `QueryRepository`
  contracts, plus `InMemoryRepository.queryProjection` and `queryActivity`. Existing command
  repositories, array-returning reads/order, resource definitions, and Work Requests remain
  compatible. Public declarations export the new types.
- Implemented UTF-8 physical-key ordering (including the existing optional item-ID suffix),
  half-open projection ranges, direction, 50-item defaults/200-item maximum, detached records,
  and keyset continuation that survives deletion of the boundary item. Activity stays ascending.
- Added bounded canonical version-1 cursors with query-scope fingerprints, strict shape/key
  validation, and the additive `query.invalid` error. The only AWS-runtime change maps that
  shared error to HTTP 400; DynamoDB paged queries remain Phase 3 work. Documented replay,
  lack of snapshot/signature guarantees, and application-owned filter/authorization scope.
- All 71 new query tests and 24 existing core tests passed. A built-package smoke compared
  32 projection paging/range/direction combinations and tied activity paging against the
  exported AWS physical-key mappers; all matched.
- `pnpm verify:release` passed: formatting, workspace typecheck, all 231 unit tests, lint,
  builds, pkg-guard (zero findings), isolated generated-app install/typecheck/tests/build/
  AWS bundle/synth/doctor, and six package dry runs. Local Markdown links and
  `git diff --check` passed.
- No LocalStack scenario was rerun: no SDK/service boundary or provisioning behavior changed.
  No dependencies, package versions, workflows, real AWS resources, release, or commit were
  changed/created. Phase 3 has not started.

### Phase 3: October 31, 2026

- Implemented `DynamoDbRepository.queryProjection` and `queryActivity` with public keys/
  mappers and core's shared async query-preparation/cursor helpers. Each read makes at most
  one bounded Query; empty pages retain the exact service continuation sort key. Known
  partitions are reconstructed, not accepted from callers. Invalid/backwards service keys
  fail closed; transport failures are not converted into empty success.
- Preserved half-open projection ranges by selecting the near key condition and trimming/
  terminating at the far boundary. Kept legacy array APIs and application filter budgets
  unchanged. Switched shared SHA-256 hashing to native Web Crypto to avoid a Node-crypto
  browser externalization warning, with explicit version-1 cursor compatibility tests.
- Added fourteen shared query contract cases per adapter, SDK boundary cases, public helper
  coverage, and bounded batch-fixture tests. Current suites have 111 core tests, 76 AWS
  runtime tests, and 45 consumer tests.
- The extended live gate passed on the same pinned ARM64/Hobby-attested lab: 260 large
  projection records, a service-shortened 123-item page from a 200-item request, empty
  filtered-page continuation, eight range/direction cases, seventeen activities over six
  pages, transactional sort/partition movement, and deleted-boundary continuation all
  matched memory. The prior S3/Scheduler/DLQ, sentinel reset, and reprovision proofs passed
  again. Full results and run identifiers are in [LocalStack Evidence](localstack-evidence.md).
- `pnpm verify:release` passed: formatting, workspace typecheck, all 281 unit tests, lint,
  builds, pkg-guard (zero findings), isolated generated-app install/typecheck/tests/build/
  AWS bundle/synth/doctor, and six package dry runs. Local Markdown links and
  `git diff --check` passed. Final teardown left no owned containers or Docker network.
- No dependencies, package versions, workflows, real AWS resources, release, or commit
  were changed/created. Phase 4 has not started.

### Phase 4: October 31, 2026

- Exported presentation-only `ResourceUiDefinition`/`CommandUiDefinition` contracts and
  narrowed config, all six resource component inputs, and form helpers to them. Full core
  resource definitions remain structurally assignable. New metadata fixtures use only
  literal presentation fields and shared Zod schemas, without fake `decide` functions or
  server imports. This does not sanitize full resource objects or migrate legacy consumers.
- Exported `JawStackApiError extends Error` with code, actual HTTP status, opaque details,
  and optional correlation ID. The fetch client preserves server messages/application
  codes, safely classifies malformed responses/JSON, and leaves network/abort/body-stream
  failures unchanged. Existing request paths, auth headers, success payloads, and command/
  idempotency serialization remain compatible. Error fallbacks are explicit in the design
  and [Angular README](../../../packages/angular/README.md).
- All 42 Angular tests passed: eight legacy cases, seven presentation-only component/
  config cases, twenty-six client/error cases, and one source browser-boundary build.
  The same fixture bundles the compiled public entrypoint after every library build;
  esbuild's graph guard rejects Node builtins/HTTP shims, core runtime, AWS SDK/runtime,
  and CDK imports. Both modes passed with zero server-runtime imports. This is DOM/build
  coverage, not browser layout or editorial-application acceptance.
- Added esbuild and Zod as test/build-only Angular dev dependencies using already-resolved
  versions; the lockfile changes only those importer entries. No public runtime dependency
  or package version changed, and no new pkg-guard suppressions were needed.
- `pnpm verify:release` passed: formatting, workspace typecheck, all 315 unit tests, lint,
  builds (including the compiled browser guard and legacy demo), pkg-guard (zero findings),
  isolated generated-app install/typecheck/tests/build/AWS bundle/synth/doctor, and six
  package dry runs. Local Markdown links and `git diff --check` passed.
- No LocalStack/real-AWS scenario was run: no SDK/service boundary or provisioning behavior
  changed. No workflows, release, or commit were changed/created. Phase 5 has not started.

### Phase 5: October 31, 2026

- Exported `JawStackWorkerBinding` and additive readonly `workerBindingsByName`/
  `schedulerFunctionsByName` records. Worker entries expose the original function, queue,
  and DLQ; schedule keys use declaration names even when handlers are shared. Existing
  arrays/order, construct props, physical naming, logical IDs, and default topology/grants
  remain unchanged. Maps/wrappers are frozen while CDK constructs remain composable.
- Added upfront duplicate-name validation across resources within each namespace, plus
  clear missing/blank handler-entrypoint errors before infrastructure creation. Handler
  entries must be own properties. Maps have no prototype fallback; unknown names return
  `undefined`, explicitly represented in public types regardless of consumer compiler flags.
- All 28 CDK tests passed, including fifteen new cases/type assertions. Captured the baseline
  logical-ID/type snapshot before production edits and verified it stayed unchanged. Tests
  cover multiple resources, shared scheduler handlers, independent namespaces, missing/
  duplicate/inherited entries, empty maps, and prototype-like declared names.
- Offline synth assertions prove application composition through public bindings: object-
  prefix S3 access reaches only the selected worker, table writes reach only the selected
  scheduler, and an application-owned DLQ collector receives the correct event source and
  table/queue grants without tree inspection. Runtime collection/idempotency behavior and
  deployment/IAM enforcement are not claimed by these synth-only checks. Usage is documented
  in the [CDK README](../../../packages/aws-cdk/README.md).
- `pnpm verify:release` passed: formatting, workspace typecheck, all 330 unit tests, lint,
  builds, pkg-guard (zero findings), isolated generated-app install/typecheck/tests/build/
  AWS bundle/synth/doctor, and six package dry runs. Local Markdown links and
  `git diff --check` passed. Public declarations export the new binding types and records.
- No LocalStack/real-AWS run or deployment was performed. No dependencies, package versions,
  workflows, release, or commit were changed/created. Phase 6 has not started.

### Phase 6: October 31, 2026

- Added strict Zod editorial state/input/version-1 fact schemas, UTF-8/serialized payload
  bounds, four immutable local fixture identities, browser-safe presentation metadata, and
  pure content/review resource factories. Content commands implement create/edit, submit,
  editor decisions, reopen, and eligible archive. Resolved fixture roles/ownership, expected
  versions, current review/revision matching, and stored/resulting state checks run before
  commit. No Work Request helper or second event publisher is used.
- Content remains authoritative. Full frozen submitted snapshots travel in requested/
  decided/superseded facts with the next content `sourceVersion`. Primary version, revision
  UUID, and review UUID are distinct; unchanged saves preserve revision. Pure projection
  plans retain creation-time ordering and explicitly delete obsolete status/due keys.
- Added internal review `createSnapshot`/`applySnapshot` primitives because core requires
  commands and separates creates from updates. They preserve immutable submission fields,
  enforce service identity/source-version progression, and cannot authorize content
  transitions. The review browser command map is empty. Phase 9 still owns source/envelope
  validation, ignore/reload loops, transport, retries, and actual projection workers.
- Scope is explicit in the design and [consumer README](../../../apps/content-operations/README.md):
  attachments accept only an empty array until Phase 8; reserved execution statuses are
  fixture-seeded for editorial guard tests, not executed schedules/publications. Full
  operational publication state, scheduling/time-zone rules, scoped dispatch/idempotency,
  HTTP, and UI remain in their planned later phases. No production fixture-auth claim is made.
- All 96 new domain tests and 141 consumer tests passed: lifecycle matrix, ownership/forged
  roles, stale versions/reviews, concurrent edits/submissions, immutable snapshots, bounds,
  malformed state/facts, secondary-review authority, pure manifest construction, and a real
  browser-targeted shared-metadata bundle. New Angular access is a type-only workspace dev
  dependency with source-path/compiler settings matching the existing demo; no external
  dependency or public runtime package change was introduced.
- `pnpm verify:release` passed: formatting, workspace typecheck, all 426 unit tests, lint,
  builds, pkg-guard (zero findings), isolated generated-app install/typecheck/tests/build/
  AWS bundle/synth/doctor, and six package dry runs. Local Markdown links and
  `git diff --check` passed. The existing LocalStack proof remains unchanged and was not
  rerun; it is not evidence of deploying the new editorial domain.
- Preserved the uncommitted Phase 5 changes. No framework implementation, package version,
  workflow, real AWS resource, release, or commit was changed/created in Phase 6. Phase 7
  has not started.

### Phase 7: October 31, 2026

- Added private invocation-scoped dispatch and memory/DynamoDB persistence factories. Each
  command captures resolved identity, command fields, and server time without retaining an
  opaque ingress context. Keys are mandatory, bounded safe ASCII; scope includes resource
  type, command, and subject. No shared repository scope is mutated.
- Seven-day logical expiry is checked on reads and in the transactional replacement
  condition, without waiting for TTL deletion. Competing commits and ambiguous SDK outcomes
  use bounded strong replay reads, then the core's own fingerprint check to return the
  stored original response. No private fingerprint code or stale mutation retry is added.
- Composed public builders with one strict create-only command receipt per resource
  version. Primary/activity/outbox/projections/idempotency/receipt commit together; memory
  stages under a per-store queue and publishes synchronously. Worker-specific operation
  variants remain later phases, not an arbitrary SDK transaction extension point.
- Shared transaction planning canonicalizes physical projection keys, coalesces equivalent
  deletes/puts and sort aliases, rejects conflicting puts/duplicate physical actions, and
  enforces the 60-action budget before writes. Primary version and idempotency conditions
  remain in the transaction; exact old projection keys are removed in both adapters.
- Added 29 credential-free adapter/dispatch tests: concurrent creates/edits with exact
  response replay, conflicting payload/target reuse, resource/command/subject isolation,
  expiry boundaries, immutable scope/time, opaque contexts, stale-decision race replay,
  auxiliary rollback, status/due/sort/partition moves, 60/61 actions, bounded keys, SDK
  failures, and ambiguous successful commits. All 170 consumer tests passed.
- The complete `feasibility-paging-and-scoped-transactions` live gate passed on the pinned
  ARM64 LocalStack image and user-attested Hobby tier in 174.664 seconds. Both adapters
  passed six concurrent creates and six concurrent edits, logical expiry with an undeleted
  record, conditional rollback, and physical projection moves/deduplication. The prior
  event-spine, paging, automatic Scheduler, actual redrive/collector, sentinel-safe reset,
  and reprovision proofs also passed. See [evidence](localstack-evidence.md).
- `pnpm verify:release` passed: formatting, workspace typecheck, all 455 unit tests, lint,
  builds, pkg-guard (zero findings), isolated generated-app install/typecheck/tests/build/
  AWS bundle/synth/doctor, and six package dry runs. Local Markdown links and
  `git diff --check` passed. The owned lab was stopped after verification.
- No public framework implementation, dependency, package version, workflow, real AWS
  resource, release, or commit was changed/created. Editorial worker transport, HTTP, UI,
  production IAM, and real-AWS deployment remain outside this phase. Phase 8 is next.

### Phase 8: October 31, 2026

- Added strict attachment-slot/object-reference schemas and content-owned registration,
  internal verified completion, draft removal, and internal expiry commands. Registration/
  removal/expiry invalidate revisions; completion preserves membership/revision. Submission
  rejects pending slots and freezes only ready object references. All serialized bounds,
  fixture ownership, expected versions, generated-key identity, and source-version checks
  remain enforced; clients cannot provide trusted storage identity or verification metadata.
- Added a pure asset factory with internal snapshot creation/application, monotonic source
  versions, immutable verification metadata, terminal tombstones, and stable per-content/
  list projections. Both review and asset UI command maps are empty. Phase 9 still owns
  workers, subscriptions, source-envelope validation, and ignore/reload loops.
- Chose 10 active/32 total retained slots to keep tombstones without unbounded aggregate
  history. Registration fails at capacity rather than losing references. Verified retired
  bytes remain until explicit reset; automatic pending expiry and safe unverified-orphan
  deletion remain Phase 12. This conservative policy also retains historical approvals.
- Added bounded memory and guarded local-only S3 object stores: generated UUID paths,
  PNG/JPEG/PDF signature checks, exact declared/actual sizes up to 10 MiB, server SHA-256,
  conditional creation, bounded readback, and mismatch rejection without overwrite. No
  delete API is exposed. Memory has explicit object/byte capacity; S3 has owned-bucket/
  region checks, explicit dummy credentials, endpoint/final-transport guards, finite SDK
  requests and three conditional-409 attempts. No dependency or framework API was added.
- Added the transport-independent upload service: two in-flight streams per instance,
  30-second cancellation/byte bounds, authority rechecks before/after object I/O, and at
  most three optimistic completion attempts. Read-only matching retries do not mutate ready
  state. An object-only write can recover after an interrupted completion; removal/expiry/
  submission races cannot mark an invalid slot ready. Deadline handling returns even when
  an async producer never settles `next()`/cleanup. HTTP routes remain Phase 14.
- Added 51 credential-free domain/upload/object-store tests (221 consumer/506 workspace
  tests total): malicious filenames/roles/IDs, media/size boundaries, conditional duplicate/
  different bytes, corrupt readback, unsafe AWS configuration with zero sends, tombstone/
  active-slot limits, expiry, approval retention, completion/removal/submission races,
  interrupted writes, concurrency admission, hanging streams, and bounded retry recovery.
  The existing pure-manifest test now includes all three actual resources; the shared UI
  bundle still excludes domain/server/SDK imports.
- `pnpm verify:release` passed: format/typecheck/tests/lint/build, pkg-guard with zero
  findings, isolated generated-app install/typecheck/tests/build/AWS bundle/synth/doctor,
  and six package dry runs. Local Markdown links and `git diff --check` passed. The live
  gate includes real S3 plus DynamoDB upload recovery and all previous spine/paging/scoped/
  Scheduler/redrive/sentinel/reset/reprovision checks; observed details are recorded in
  [LocalStack evidence](localstack-evidence.md). The owned lab was stopped after verification.
- No public framework implementation, package version, dependency, workflow, real AWS
  resource, release, or commit was changed/created. Signature checks are not full media
  decoding/sanitization or antivirus; no editorial HTTP/UI or deployed materializer is
  claimed. Phase 9 is next.

### Phase 9: October 31, 2026

- Added shared review/asset materializers with strict expected-source, version-1 envelope,
  target, and full payload validation. Strong target reads ignore older/equal-identical
  source versions; equal-version rewrites conflict. Newer snapshots use internal scoped
  commands and at most three optimistic load/compare/upsert attempts. Full approved/removed/
  expired snapshots may arrive first without later opening facts reviving them. Incoming
  correlation is retained; the transport event ID becomes request/downstream causation ID.
- Registered only the three implemented workers on content: review materialization,
  asset materialization, and review request/decision notifications. Materializer outputs
  have no subscribers. Publication/reminder subscriptions remain absent until implemented.
  Dispatch and handlers share an explicit stage source; shared metadata/schema imports
  remain browser-safe, while worker definitions live in the server domain layer.
- Added strict deterministic notification rendering and an actual local destination, not
  an external-provider stub. Original event ID, fixture recipient, and versioned template
  determine a stable SHA-256 delivery ID. A canonical fact hash rejects different business
  content at that identity. Reserved payload replay metadata has strict keys/generation 1-3;
  Phase 13 still owns authorized replay creation from stored original envelopes.
- Memory atomically inserts destination, typed operation, and two shared-store query rows;
  DynamoDB conditionally commits those four rows in one transaction. Duplicates/ambiguous
  responses strongly reread and return the first record and metadata. All/recipient queries
  use public projection/paging contracts (50 default/100 maximum). Business deduplication
  records have no TTL; memory capacity rejects new deliveries rather than evicting history.
- Added explicit memory runtime composition, monotonic fixture clock, and bounded outbox
  pump with no automatic service/timer/backend selection. Default passes scan/attempt at
  most 50 events/handlers; retries use +1/+2-second injected-clock cutoffs and stop after
  three attempts. Pending/terminal jobs and seven-day marker caches have bounded capacities;
  whole event fan-out backpressures before cursor advancement. Failed jobs retain their
  original event and expose sanitized diagnostics. Marker expiry/eviction cannot duplicate
  business effects. Concurrent drains serialize; bounded drain-until-idle never advances time.
- Added 40 tests (25 worker/memory-flow and 15 notification contracts): complete out-of-order
  upserts, concurrent creates/updates/sink delivery, shared projection-write safety, invalid
  envelopes/sources/outcomes, optimistic bounds, first-response replay after marker expiry/
  new transport IDs, after-commit marker gaps, four-row rollback, ambiguous SDK success,
  paged ties, capacities/backpressure, failed/healthy isolation, no loops, clock/drain guards,
  and complete headless draft/upload/review/related-resource/notification flow. All 261
  consumer tests passed.
- `pnpm verify:release` passed: formatting, workspace typecheck, all 546 unit tests, lint,
  builds, pkg-guard (zero findings), isolated generated-app install/typecheck/tests/build/
  AWS bundle/synth/doctor, and six package dry runs. Local Markdown links and
  `git diff --check` passed. No LocalStack run was required/performed; SDK transaction
  contracts do not claim live consumer Lambda/queue integration. The Phase 8 live evidence
  remains the last observed local integration gate, and its lab remains stopped.
- No framework implementation, dependency, package version, workflow, real AWS resource,
  release, or commit was changed/created. Live consumer transports, publication, automatic
  HTTP pumping/UI, and durable failure collection/replay remain later work. Phase 10 is next.

### Phase 10: October 31, 2026

- Added strict editor schedule/reschedule/cancel, publish-now and explicit retry commands,
  plus dedicated due-worker and publisher request/claim/complete/fail primitives. Every
  mutation uses expected resource version and current approval/revision, schedule generation,
  or publication/generation/fence references. Timestamp input requires explicit millisecond
  offsets, normalizes to UTC, and validates future time/IANA zone; Temporal local-time/DST
  conversion and automatic due jobs remain Phase 12. Old calendar/due keys move/delete in
  the authoritative transaction; cancel/reopen/reschedule/due races have one winner.
- Publication freezes one ID, submitted snapshot/approval, optional original schedule, and
  request timestamp. Retry changes only execution generation and cannot burn a new cycle
  using an older generation's failure. All queued/running/failed/stalled publication keeps
  the content publishing lock; lease expiry/failure never authorizes edits/removal/reopen/
  archive. Published state may archive while retaining its frozen intent/artifact reference.
- Added caller-fresh attempt UUIDs, server fencing UUIDs and exactly 90-second leases.
  Outcomes require every active reference and time within the lease. Claims are limited to
  three attempts per cycle and four generations (initial plus three editor retries).
  Allowlisted unavailable/interrupted failures retry within budget; mismatch/invalid-snapshot
  codes terminate immediately. No raw exception strings enter state/events/history.
- Added app-only claim-response post-validation after normal and idempotent/concurrent
  execution. A once-successful response cannot grant an expired, completed, replaced,
  not-yet-started, or timestamp-mismatched lease. Different input at the same key still
  conflicts normally; actual new attempts require new UUIDs/keys. Core was not changed.
- Composed typed immutable attempt-stage rows and all/per-content history projections with
  the existing public transaction builders and primary state/activity/outbox/idempotency/
  receipt writes. Generation is metadata, not part of claim-history uniqueness, so past
  attempt UUIDs cannot recur in later generations. Successor claims/retries close expired
  predecessors in the same commit. Query rows keep stable start/attempt order and update
  stage data; no unbounded aggregate history or after-success second write is used. Both
  adapters preserve primary/idempotency conditions, exact-key deduplication and 60-action cap.
- Added 42 publication tests (303 consumer/588 workspace tests total): memory and SDK domain
  parity, opposite-order scheduling races, due-generation staleness, exact lease boundaries,
  concurrent equivalent claim replay, all fencing fields, regressed clocks, stale timestamp
  grants, cross-generation attempt reuse, transient/terminal failures, exhausted/expired
  attempt budgets, manual retry limits, typed-operation rollback, 60/61 actions, malformed
  state/metadata/roles/IDs, fixed artifact identity, redacted token history, and absence of an
  unfinished publisher. Existing editorial transition tests now use actual schedule/publish/
  claim/complete commands instead of fabricated reserved states; no artifact I/O is claimed.
- `pnpm verify:release` passed: format/typecheck/tests/lint/build, pkg-guard with zero
  findings, isolated generated-app install/typecheck/tests/build/AWS bundle/synth/doctor,
  and six package dry runs. Local Markdown links and `git diff --check` passed. No LocalStack
  run was required/performed; Phase 8 remains the last observed live integration evidence.
- No framework implementation, dependencies, versions, workflows, real AWS resources,
  release, or commit was changed/created. No actual artifact serializer/writer/verifier or
  `publishContent` subscription is presented as implemented; that protocol is Phase 11.
  Internal completion currently accepts trusted metadata with fixed key/size/digest shape.

### Phase 11: October 31, 2026

- Added explicit-order version-1 UTF-8 JSON artifacts with UTC instants, asset-ID-sorted
  attachments, trailing LF, bounded bytes, fixed key, and exact SHA-256. Frozen intent alone
  determines bytes across attempt/generation retries; execution metadata is excluded.
- Memory and guarded local S3 stores conditionally create and verify artifacts without
  overwrite. S3 checks exact bytes plus JSON type, length, digest, and object identity.
  Matching objects recover; corruption terminalizes the current publication generation.
- Implemented shared claim -> write/verify -> domain completion execution with strong
  rereads, fresh attempt UUID/action keys, finite conflict budgets, lease/fence checks, and
  conditional failure recording. Live competitors throw for retry; stale workers cannot
  fail successors. Completed duplicates and obsolete generations do not mutate business state.
- Registered the real memory publisher and publication success/terminal-failure notifications.
  Outcome facts include the attempt's stable `outcomeAt`, retaining replay-safe notification
  identity/order. No direct notification provider calls or second publication authority exist.
- Added `publication.zip` with the public framework SQS adapter/marker store. The entire
  bounded batch validates queue/source/type/facts before marker lookup; markers follow domain
  completion. The Lambda S3 path requires the owned publisher context/fixed local endpoint.
  The existing four-function spine topology is unchanged; consumer deployment remains Phase 20.
- Added 28 tests (331 consumer/616 workspace total): actual memory publication/notification,
  crashes before/after object creation and completion, lease recovery, live duplicate rejection,
  stale-worker fencing, attempt budgets, corruption and explicit generation retry, stable
  serialization/Unicode/attachment order, memory/S3 parity and bounded 409 retries, metadata/
  stream corruption, Lambda context isolation, bundle exports, marker-write gaps/physical
  expiry, and validation of cached deliveries/whole batches. Fault callbacks are test-only
  dependencies at exact operations, not environment switches or public endpoints.
- `local:up`, `local:provision`, and `verify:local --confirm-reset` passed the complete live
  gate in 206.167 seconds. The shared publisher on real DynamoDB/S3 recovered an injected
  post-object interruption after logical lease expiry, retained expired/succeeded history,
  converged on one artifact, left completed duplicates unchanged, and terminalized corrupt
  bytes without overwrite. Earlier managed transport/Scheduler/redrive/reset/reprovision
  proofs passed again. See [recorded evidence](localstack-evidence.md) for IDs and exclusions.
- `local:down` passed; no owned containers/network remained. The publication service was
  called directly for this focused proof, not deployed as a consumer Lambda. This is not
  replaced transport evidence: the separate spine still used actual stream/bus/queue/Lambda.
- `pnpm verify:release` passed: format/typecheck/tests/lint/build, zero pkg-guard findings,
  isolated generated-app install/typecheck/tests/build/AWS bundle/synth/doctor, and six package
  dry runs. Local Markdown links and `git diff --check` passed.
- No public framework implementation, dependencies, versions, workflows, real AWS resources,
  release, or commit was changed/created. Automatic due/reminder/cleanup jobs, full consumer
  AWS wiring, HTTP, UI, and operational recovery remain later phases.

For later phases, append the date, meaningful behavior delivered, commands/results,
not-run checks, design changes, and remaining limitations. Do not replace observed
results with the phase's intended acceptance criteria.
