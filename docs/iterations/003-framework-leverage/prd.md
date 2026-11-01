# Iteration 3 PRD: Framework Leverage

Status: reviewed as the basis for the [technical design](technical-design.md). This specifies
product outcomes and boundaries, not shipped APIs or permission to begin implementation.
Material scope changes require review under the [iteration process](../README.md).

## Summary

Turn two proven application protocols into supported JawStack capabilities:

1. Invocation-scoped command execution and atomic persistence.
2. Durable asynchronous worker failure inspection and bounded recovery.

Content Operations must become simpler because it consumes these capabilities. A small
independent Report Runs application must use the same contracts without copying its
infrastructure, importing its source, or modifying framework internals for its domain.

The target is agentic development: an agent supplies business rules and composes tested
architecture instead of implementing transaction, delivery, and recovery machinery again.
Fewer generated files or more package exports alone do not demonstrate that outcome.

This is a framework-leverage iteration, not another large application build, a general
workflow engine, or a production-readiness/release campaign.

## Baseline and Problem

[Iteration 2](../002-content-operations/outcome.md) established a maintained editorial
application, public paged queries, Angular presentation/error contracts, named CDK bindings,
and substantial memory/browser/LocalStack acceptance. It demonstrates that JawStack can
support another domain. It does not establish a measured development-speed advantage.

The consumer still implements reusable mechanics in and around:

- `application/dispatch.ts`: invocation scope, bounded replay after ambiguous commits.
- `application/persistence.ts`, `application/memory.ts`, `aws/persistence.ts`: logical
  command expiry, physical-key normalization, atomic auxiliary records, and adapter parity.
- `application/failure-records.ts`, `application/failures.ts`, `aws/failures.ts`: durable
  collection, bounded history, authorized targeted replay, and reconciliation ordering.
- `application/pump.ts`, `aws/delivery.ts`, `aws/recovery.ts`: memory delivery, transport
  validation, marker ordering, and consumer/recovery wiring.

These files also contain application policy. Extraction must separate that policy rather
than relocating the entire consumer into framework packages. In particular, publication
reconciliation currently understands editorial authority and live publication claims.

The lab has useful isolation and cleanup safeguards, but another consumer should not need
to clone its provisioning/lifecycle implementation. Conversely, this iteration must not
become a universal emulator provisioning framework. CDK synthesis and SDK lab provisioning
remain different verification surfaces; neither is currently real-AWS deployment proof.

## Target Users and Jobs

The primary user is a coding agent implementing or extending a TypeScript application
with transactional commands and asynchronous AWS workers. The human maintainer reviews
domain behavior, public contracts, evidence, and cost/security boundaries.

The agent should be able to:

- Add a command and application-owned transactional record without implementing a unit
  of work, SDK transaction planner, or second memory transaction algorithm.
- Register a worker and its domain handler without implementing a new failure ledger,
  collector, replay protocol, memory pump, or per-consumer queue wiring algorithm.
- Run a fast credential-free workflow, then separately verify actual local AWS transports.
- Understand the supported path from public documentation, types, examples, and diagnostics,
  with application-specific escape points identified explicitly.

This scope targets applications needing these capabilities. It does not claim JawStack
should be required for every small Lambda or that a simpler application needs this topology.

## Goals

- Replace selected Content Operations infrastructure algorithms with supported public contracts.
- Preserve its editorial behavior, safety properties, public local HTTP behavior, and workbench.
- Prove reuse in an independent domain with minimal application-owned integration machinery.
- Make selected memory/AWS behavior come from shared contracts rather than parallel app implementations.
- Keep generated-app/package verification independent of workspace source aliases and build caches.
- Measure structural leverage and actual agent change effort against a frozen pre-extraction baseline.
- Keep local integration explicitly bounded, disposable, ownership-safe, and without real-AWS fallback.

## Non-Goals

- Extracting every generic-looking file, creating a plugin marketplace, or replacing the core architecture.
- A workflow/DAG engine, distributed saga platform, arbitrary cross-resource transaction DSL, or ORM.
- A generic publisher lease/fencing engine, immutable S3 artifact platform, upload service, or notification provider.
- Extracting recurring-job checkpoint/lease policy, reminders, scheduling UI, or object cleanup.
- A new Angular component system, generated custom screens, second CLI starter template, or broad CLI redesign.
- A large reporting product, CSV/PDF rendering, arbitrary code execution, or analytics infrastructure.
- Production authentication, multi-tenancy, internet ingress, real-AWS deployment, or IAM parity certification.
- Replacing SDK lab provisioning with CDK deployment to LocalStack or requiring additional paid emulator services.
- Exactly-once delivery/external effects, automatic replay of unsafe business operations, or guaranteed spend caps.
- npm publication, coordinated version changes, tags, release automation, or remote secret setup by default.

## Ownership and Scope

| Owner              | Required responsibility                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework packages | Scoped command runtime/persistence contracts; memory/DynamoDB implementations; generic bounded worker collection/recovery and delivery machinery; required public composition bindings and regression tests.        |
| Content Operations | Editorial decisions/identities, frozen revisions and approvals, publication claims/fences, artifact/upload policy, notification content, recurring-job policy, screens, and thin capability configuration/adapters. |
| Report Runs        | Inventory-report request/result schemas, deterministic report calculation, caller/operator policy, thin HTTP/CLI composition, fixtures, domain tests, and walkthrough.                                              |
| Shared tooling     | Minimum reusable owned-lab lifecycle/provisioning and verification support for these consumers, evidence capture, isolated install verification, and leverage measurement.                                          |

Package names and exact APIs belong in the technical design. Prefer existing ownership
boundaries where coherent; a new package must remove real complexity. Framework packages
and shared lab code must not import either app. Consumers must not import each other or
deep-import framework internals. Application wrappers must perform policy/translation,
not retain copied versions of the extracted algorithms.

## Functional Requirements

### FR-01: Scoped Command Runtime

Provide a supported composition path that captures resolved identity, resource/command
scope, request intent, correlation, and server time per invocation. Concurrent callers
must not share mutable request context or accidentally share idempotency scope.

The selected capability requires a bounded idempotency key. Equivalent retries return
the original committed response; different intent in the same scope conflicts. Target
resource identity participates in intent matching. A new invocation is not an invitation
to retry a stale domain decision after a version conflict or ambiguous SDK outcome.

Support bounded replay lookup after an ambiguous commit without performing a second
mutation. Logical expiry must work before physical DynamoDB TTL deletion, with conditional
expired-row replacement and matching memory behavior. Content Operations retains its
seven-day policy; expiry is explicit capability configuration, not a silent change to
legacy framework defaults.

The application can validate domain-sensitive responses, including replayed publication
claim responses, against current authority. A stored success must not grant a stale lease.
That publication-specific check remains application policy, not a generic lease feature.

### FR-02: Atomic Commit Contributions

Commands can contribute bounded, typed application records and projections to the same
commit as resource state, activity, outbox, and command idempotency. Content Operations
must express its command receipts and publication-attempt records through this contract.

The framework owns optimistic commit conditions, physical-key normalization, exact old-key
deletes, compatible delete/put coalescing, duplicate/conflicting-action rejection, bounds,
and equivalent all-or-nothing memory/DynamoDB behavior. Any contribution failure leaves
all authoritative state, activity, projections, receipts, and outbox unchanged.

This is not permission to submit arbitrary unvalidated SDK write objects or bypass resource
authority. Application-owned record identity, schema, lifecycle conditions, and allowed
contributions must be explicit. Keep business-specific record meanings outside the framework.
Applications declare contributions once in framework terms rather than implementing
per-adapter transaction formats; memory composition does not require an AWS client.

Preserve Content Operations' current replay/conflict and atomicity guarantees. Preserve
existing Work Requests consumers and public API behavior unless a separately reviewed
compatibility change is genuinely required.

### FR-03: Recoverable Worker Operations

Declare named consumers, allowed event types/source, strict payload validation, handlers,
bounded delivery settings, inspection authorization, and recovery policy through supported
public composition. Invalid/unsubscribed/foreign traffic and forged recovery metadata
must be rejected before effects or cached-marker acknowledgement.

Provide shared memory/AWS behavior for durable failed-delivery identity, bounded collection
and recovery history, redacted paged inspection, stable recovery-request identity, and
targeted replay of the stored original fact. Recovery must not accept arbitrary supplied
payloads, endpoints, queues, or replacement business authority.

Commit recovery authorization/history and its replay outbox entry atomically. Equivalent
operator retries cannot queue another recovery cycle. Limits on retry/receive counts,
recovery cycles, payload/history size, query work, and in-memory capacity are explicit;
Content Operations keeps its existing limits and observable error behavior.

Business completion precedes a successful processing marker. Durable collection and any
required application reconciliation precede collector acknowledgement. Interrupted
collection/replay resumes safely; deleting transport markers cannot be treated as deleting
permanent business identity. Handler side-effect idempotency remains an explicit application
responsibility; the framework does not guarantee exactly-once arbitrary external effects.

Applications can deny replay or reconcile authoritative state through narrow hooks. Content
Operations retains its publication-generation, live-claim, late-failure, and explicit editor
retry rules; extracting generic replay must not make publisher-envelope replay permissible.
A deferred or failed reconciliation must retain work for retry rather than acknowledge it.

### FR-04: Thin Runtime and Infrastructure Composition

The selected command and worker declarations must compose into both a credential-free
memory runtime and the AWS-facing adapters without each consumer writing another pump,
failure store, collector wrapper, or scoped persistence factory.

Capabilities are explicit opt-ins. Installing a dependency or using ordinary resources
must not automatically provision additional failure collectors, queues or stores. Preserve
legacy Work Requests defaults/topology, and do not require S3 or Scheduler for Report Runs.

Use public CDK bindings for required worker/collector topology and grants. App-specific
resource declarations, permissions and domain callbacks remain visible; wiring a supported
consumer must not require construct-tree inspection or modification of provider internals.

Factor only the local-lab mechanics needed to run these capabilities in both consumers.
Per-app profiles may declare exact resources and handler bindings, but must not duplicate
service provisioning, endpoint/credential guards, ownership preflight, reset, or runtime
container cleanup. Keep Content Operations' additional S3/Scheduler behavior working through
its existing configuration, not through new generic upload/job capabilities.

The shared harness may remain private repository tooling in this iteration, but it must
be outside either app's ownership. Isolated installed-consumer verification must not depend
on that tooling for the public runtime to function. SDK provisioning and CDK must be checked
against the same supported subscriptions/bounds, with intentional differences documented.
Unifying real deployment and the SDK lab is deferred; do not claim this closes that gap.

### FR-05: Content Operations Migration

Remove or reduce the selected app-owned protocol implementations, leaving domain rules,
schemas, permissions, DTO translation and thin composition. Do not keep a second implementation
as a permanent fallback or hide it in a renamed application utility directory.

Maintain the complete draft/upload/review/approval/schedule/publication/recovery workflow,
all five workbench views, existing local command/query contracts, and baseline replay semantics.
Preserve publication authority and immutable artifact identity across crash/retry/late-event
cases; a generic worker record must not become a second publication authority.

Prefer preserving stored identifiers/envelopes and existing public local responses. Any
local dataset reset or record-format transition must be explicit, tested and documented;
no automatic startup deletion or silent adoption of old records. No production data migration
or restart/reset of an existing interactive review session is authorized merely by this plan.

### FR-06: Independent Report Runs Consumer

Create the private maintained `apps/report-runs` application as a small, headless consumer.
Use a loopback HTTP API and scriptable CLI/walkthrough; a new frontend is not required.
It must be useful to exercise a report request, inspect its outcome, and export its actual
stored result, rather than merely instantiate framework types.

The single report type is an inventory snapshot: accept an immutable batch of one to
100 uniquely identified items with labels and nonnegative integer quantities, bounded to
16 KiB of input. Reject duplicates, invalid/unsafe quantities, aggregate overflow and
oversized requests before commit. The schema must ensure accepted inputs can produce a
result within the output bound; do not accept work known to be impossible to complete.
The worker produces a deterministic JSON result with item rows and aggregate counts/totals,
also bounded to 32 KiB, stored durably through normal resource commands/persistence.

The workflow is request -> committed fact -> asynchronous worker -> durable result ->
inspection/export. Repeated equivalent requests converge; conflicting input does not replace
the original intent. Re-delivery and a crash after result commit but before acknowledgement
leave one logical result. Terminal work is inspectable through the shared failure capability;
an authorized operator can request bounded recovery using the stored fact.

Report completion is business authority; worker failure/recovery records describe delivery.
Late collection cannot replace completed success, and observed status must not invent a
completed result. Rendering, export shape and operator eligibility remain application policy.
The result stays in the resource store; this app does not require S3, uploads, schedules,
external providers, or another artifact/lease subsystem just to demonstrate reuse.

Use the public capabilities for dispatch, commits, delivery and recovery. The app must not
implement custom SDK transaction planning, failure storage, a delivery pump, collectors,
or replay scheduling. Its only custom worker logic should be domain calculation/completion
and explicitly declared business deduplication/eligibility decisions.

### FR-07: Agent-Facing Contracts and Diagnostics

Provide one supported recipe for scoped commands and one for recoverable workers, including
composition, handler completion obligations, application hooks, safety limits, and runnable
memory/LocalStack verification. Examples must use public exports and neutral domain language.

Types, validation and diagnostics should identify missing registrations, unsafe configuration,
unsupported recovery, conflicts, and dependency failure without requiring the agent to read
another application's private code. Do not convert failures into empty query results or
success-shaped placeholders. Machine-readable command output must be stable enough for scripts.

Agent guidance can explain the tested path, but prose must not substitute for runtime
guarantees or require copying large application templates. A generated file that the consumer
must maintain still counts as consumer-owned infrastructure for the leverage audit.

## Leverage Evidence

### Frozen Baseline and Retirement Inventory

Before extraction, record the baseline commit, current gates, and a reviewed inventory of
the generic portions of the dispatch/persistence/delivery/failure modules listed above.
Separate domain decisions and verification fixtures from reusable protocol implementation.
Freeze counting rules before implementation; do not select favorable files afterward.

At least 50% of that baseline consumer-owned protocol implementation must be eliminated
from Content Operations, with the remainder attributable to real domain policy or thin
configuration. Count maintained runtime source, including app-owned generated code; exclude
tests, whitespace/comments, build outputs and documentation consistently in both versions.
This is a structural gate, not a claim that lines of code measure agent productivity.

Moving the same algorithms into app wrappers, a second app, or copied generated files
does not count. Shared code must have domain-neutral contracts, independent tests and
actual use by both consumers. Total framework growth and new public concepts must also
be reported so reduced app size cannot hide an excessively complicated replacement.

### Paired Agent Change Exercises

Freeze two equivalent change specifications and acceptance tests before running their
baseline implementations against the pre-extraction Content Operations snapshot:

1. Add a typed, create-only approval receipt to the approval transaction. Contribution
   failure must roll back the domain decision and its outbox/activity in both adapters.
2. Add a subscriber to an existing publication fact that records one durable business
   receipt, supports inspectable terminal failure and authorized recovery, and remains
   logically idempotent after marker loss or a lost successful acknowledgement.

Repeat each task against the refactored snapshot in fresh agent contexts with the same
specification, acceptance tests, model/tool settings and declared work budget where practical.
Reset snapshots between tasks; do not give the later attempt the earlier solution patch.
Keep benchmark-only features in disposable patches unless separately approved for the app.

Record visible work: elapsed active agent/tool time, separately itemized install/service
waits, correction rounds, files and generic integration code changed, verification results,
and token usage only when actually available. Include setup/documentation burden, failed
attempts and confounders; do not infer hidden reasoning or fabricate token measurements.

Both post-extraction tasks must be implementable without new framework-internal changes
or handwritten implementations of the extracted transaction/delivery/recovery protocols.
The review must show reduced generic integration work across the paired tasks, not merely
shorter prompts or more code generated automatically. Timing/token results are supporting
observations, not a promised universal speed multiplier from two samples.

This measures improvement over the current JawStack consumer, not a controlled comparison
with a complete from-scratch AWS application. A separate raw-SDK benchmark is deferred.
An inconclusive or negative leverage result is a no-go for calling the extraction a proven
accelerator: report it and review scope rather than endlessly optimizing or weakening tests.

## Development Modes and Safety

- Default imports, tests, typechecks, builds and memory workflows need no Docker, token,
  cloud credentials, provider account, or AWS request. Unit tests pass before package builds.
- Run the real integration gates against the existing pinned, explicitly provisioned,
  user-attested Hobby profile. Revalidate only changed service requirements; no paid trial,
  new paid feature, or real-AWS fallback may be introduced to make acceptance pass.
- Guard final SDK transport destinations and queue identities, use dummy credentials,
  reject inherited real-AWS settings, and bind host services to loopback.
- Isolate app/lab identities and ownership manifests. Reset/down must preserve foreign
  resources, handle owned orphan runtimes safely, and retain failed-cleanup evidence.
- Preserve the existing interactive review dataset. Disposable acceptance instances use
  explicit ports/identities; expensive release/browser/Docker gates run sequentially.
- Validate archive imports and keep injected faults in verification-only bundles. Live
  success must use actual streams/bus/queues/Lambdas; direct host invocation is not a substitute.
- Keep CI PR/manual-only. Do not add push triggers, dispatch jobs, configure remote secrets,
  or copy a local token to GitHub without explicit authorization. Missing prerequisites
  produce a failing NOT-RUN, never a passing integration result.

## Verification and Acceptance

| ID    | Acceptance Criterion                                                                                                                                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC-01 | Public scoped command composition is used by both apps; concurrent subjects/commands/targets, equivalent/conflicting retries, ambiguous commits and logical expiry behave correctly in memory and DynamoDB.                                                                    |
| AC-02 | Typed auxiliary contributions and projection moves commit atomically with state/activity/outbox/idempotency; duplicates, conflicts, excess work and contribution failures reject or roll back identically across adapters without app-owned transaction algorithms.            |
| AC-03 | Shared worker validation, durable collection, paged inspection and authorized bounded replay work for both domains; invalid replay is rejected before marker acknowledgement, collection resumes after interruption, and replay history/outbox commit atomically.              |
| AC-04 | Content Operations' domain authority, claim fencing, publication retry restrictions, local API behavior and full memory/browser/live failure acceptance remain intact after migration; existing assertions are not weakened to accommodate extraction.                         |
| AC-05 | Report Runs completes request -> real asynchronous processing -> durable bounded JSON result -> inspection/export in memory and LocalStack; terminal failure/recovery and post-completion redelivery leave one logical result.                                                 |
| AC-06 | Neither consumer copies the selected protocol implementations, imports the other app, or deep-imports package internals. Shared local tooling has app-neutral ownership; supported consumer registration does not require custom provisioning/collector code.                  |
| AC-07 | The frozen retirement inventory shows at least 50% less consumer-owned generic protocol implementation in Content Operations, with remaining code classified and framework/API growth disclosed.                                                                               |
| AC-08 | Both paired agent change exercises pass equivalent acceptance tests; post-extraction work needs no framework-internal edits or new implementations of extracted plumbing, and the evidence shows reduced generic integration work with honest effort measurements/limitations. |
| AC-09 | An isolated Report Runs composition installs packed public packages outside the workspace, passes its memory command/worker workflow, and builds/import-checks its real AWS entrypoints without source aliases, deep imports, another app, or a pre-existing build cache.      |
| AC-10 | The from-clean-install release gate passes with tests before builds; Work Requests, generated-app lint/typecheck/tests/build/synth/doctor, browser boundaries, package guard and package dry runs remain green.                                                                |
| AC-11 | Final opt-in local gates prove actual command/stream/bus/queue/Lambda delivery, transient/terminal failure and recovery, zero-network unsafe-configuration rejection, sentinel-safe reset/reprovision and owned teardown for both consumer compositions.                       |
| AC-12 | Current package/application recipes, local service limits, compatibility decisions and an outcome/acceptance/leverage report distinguish delivered behavior from emulator exclusions, unperformed AWS checks and unproven productivity claims.                                 |

Share generic adapter/protocol regression suites where useful, but retain application tests
for editorial and report authority. Full local evidence must include automatic retry/redrive
and durable collector ordering at normal configured bounds, not only mocks or accelerated
memory clocks. Distinguish diagnostics that intentionally republish stored facts from normal
application traffic. A successful integration result includes ownership-checked teardown.

The existing complete Content Operations browser suite and its live workflow remain gates.
Report Runs uses headless HTTP/CLI acceptance, not a new browser suite or UI project.
LocalStack/IAM/Scheduler/ingress exclusions from Iteration 2 remain explicit; package synth
and installed-consumer success do not certify real-AWS deployment or production security.

## Documentation and Delivery

- Current public command/commit/worker recipes with extension obligations and neutral examples.
- Updated Content Operations architecture/runbook describing removed infrastructure and retained policy.
- Report Runs README with input bounds, identity, modes, commands, real outputs and recovery walkthrough.
- Shared local-harness ownership/configuration instructions, service matrix, safety and cleanup guidance.
- A frozen baseline/retirement inventory and reproducible paired change specifications/results.
- An iteration outcome mapping AC-01 through AC-12 to actual tests/commands/evidence, including
  the leverage verdict, compatibility changes, failed/not-run checks and remaining gaps.

Preserve Iterations 1 and 2 as history. Do not advertise this draft as shipped capability
or create empty technical-design/implementation-plan placeholders. Plan a bounded effort
of roughly 10-15 reviewable implementation phases where feasible; split or narrow the
iteration during design review if the scope cannot fit coherently, rather than quietly
turning it into another broad application/platform build.

## Completion and Release Decision

Completion requires working shared capabilities, both consumer proofs, preserved regression
and safety guarantees, installed-package evidence, and a positive reviewed leverage verdict.
An implementation that passes functional tests but still duplicates generic machinery or
has no demonstrated integration benefit has not achieved this iteration's product outcome.

Keep package versions unchanged unless a separate release is explicitly prepared. This
work may justify a coordinated dogfood release after review, but it does not authorize
publication, tagging, release automation, real-AWS costs, or remote secret configuration.
The agent implements and verifies; the user reviews and commits. No automatic commits,
pushes or merges are part of the phase workflow.

## Technical Design Decisions

The TDD must settle public API/package placement; invocation/record contribution contracts;
scope/fingerprint/expiry/replay rules; memory/DynamoDB atomicity and error translation;
worker registration and completion obligations; collection/reconciliation authorization
hooks; durable replay/legacy-envelope compatibility; shared lab/profile ownership; report
schemas and observable status; installed-consumer verification; and the frozen leverage
inventory/exercise measurement protocol.

Those decisions must preserve the product boundaries above. In particular, do not introduce
a second publication authority, generic lease/workflow engine, arbitrary SDK write hook,
new frontend product, or production deployment effort merely to simplify extraction.
