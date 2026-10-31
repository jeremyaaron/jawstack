# Iteration 2 PRD: Content Operations

Status: reviewed as the basis for the [technical design](technical-design.md). Changes to
product scope still require explicit review.

## Summary

Build a useful editorial workbench as a first-party JawStack consumer under
`apps/content-operations`. An author drafts content and attaches assets; an editor reviews
it, requests changes or approves it, and schedules or initiates publication. Background
workers produce a durable publication artifact and deliver notifications to an inspectable
local sink. The application shows what happened and whether background work succeeded.

This is a maintained reference application, not a renamed Work Requests demo. It should
exercise multiple resources, relationships, custom Angular screens, object storage,
scheduled work, and failure recovery through JawStack's public package APIs.

Iteration 2 also establishes a bounded local AWS integration path. Most application work
must remain possible without an emulator; integration acceptance must exercise actual
AWS-facing adapters against LocalStack rather than only mocked SDK calls. Neither mode
requires real AWS credentials or paid external delivery providers.

The iteration number is not a release version. Decide whether framework changes warrant
`v0.0.2` or another release only after reviewing the delivered changes and evidence.

## Baseline and Problem

[Iteration 1](../001-foundation/README.md) produced the Git-only `v0.0.1` baseline:
resource metadata, command execution, transactional persistence, events and outbox dispatch,
AWS worker and scheduler adapters, Angular resource components, CLI tooling, and a Work
Requests starter.

The baseline has not yet demonstrated that a developer can comfortably build a materially
different application. Work Request behavior remains embedded in some framework helpers
and verification. The starter's notification handler is a no-op, and its resource does not
register a domain worker or reminder schedule. Local development uses in-memory state,
not AWS emulation. Production authentication and frontend hosting are not implemented.

Adding more speculative framework modules would not establish usefulness. A real consumer
should expose the missing contracts while keeping application-specific policy and UI in
the application. Local AWS integration should make this affordable to exercise repeatedly,
without presenting emulation as proof of production security or AWS parity.

## Target Users and Use Case

The application serves a solo publisher or small editorial team coordinating a modest
content pipeline. It is also a reference for TypeScript developers evaluating JawStack's
application architecture. It is not a hosted commercial CMS or a production SaaS product.

The reference workflow uses a single shared editorial workspace and explicit local author
and editor identities. Seeded data and a documented walkthrough make it demonstrable by
one developer without real email accounts, a public website, or external integrations.

## Goals

- Complete a draft -> review -> approval -> scheduled publication workflow through the UI.
- Demonstrate at least three related resource types without depending on Work Request logic.
- Show how custom screens coexist with reusable JawStack resource and command components.
- Exercise durable events, workers, scheduling, and private object storage end to end.
- Make asynchronous progress, failure, and recovery visible instead of silently returning success.
- Provide a repeatable local AWS integration environment with no real-AWS fallback.
- Identify and implement the smallest framework improvements needed by the application.
- Preserve the Work Requests consumer, generated starter, and packaging verification.
- Document supported behavior, emulator exclusions, and remaining production-readiness gaps.

## Non-Goals

- A generic CMS, capability-module marketplace, plugin system, or second generator template.
- A rich-text editor, collaborative editing, media transcoding, or recommendation engine.
- SEO tooling, public frontend hosting, social publishing, or third-party CMS integration.
- A general automation-rule builder, notification platform, or configurable workflow engine.
- Full-text search, analytics warehouses, dashboards, or experimentation infrastructure.
- Multi-tenancy, billing, production identity-provider integration, or internet-facing deployment.
- A generic relationship ORM, arbitrary cross-resource transaction DSL, or new database adapter.
- Real-time push updates, mandatory drag-and-drop interaction, or a broad Angular design system.
- Exactly-once external side effects, perfect AWS emulation, or guaranteed AWS spend caps.
- Paid LocalStack features, real-AWS deployment, npm publication, or release automation as completion gates.

## Ownership and Scope

### Consumer Deliverables

The private `apps/content-operations` workspace package owns the editorial resource
definitions, domain commands and policies, publication format, Angular feature screens,
notification content, seed data, application infrastructure composition, and walkthrough.
Normal application code is expected; not every screen or rule must become metadata.

Consume supported JawStack package exports. Do not import package internals, another app's
source, or Work Request-specific helpers to make the consumer function.

### Framework Deliverables

Fix framework defects and add narrowly scoped reusable contracts where the consumer
demonstrates a requirement the public APIs cannot express safely. Likely pressure points
include resource-independent queries, custom command forms, worker registration, and
scheduled execution. These are areas to evaluate, not a preapproved feature inventory.

Keep editorial terminology and policy out of framework packages. Prefer keeping a new
capability in the consumer until there is evidence that extraction simplifies shared
behavior. Record each public contract change, its motivating requirement, compatibility
impact, and regression coverage in the technical design and implementation plan.

### Shared Tooling Deliverables

Provide reproducible LocalStack startup, provisioning, readiness checks, reset/teardown,
and an automated integration scenario. Share infrastructure and tooling only where doing
so removes genuine duplication. The current real-AWS deployment architecture must not be
changed solely to satisfy emulator plan limitations.

## Domain Model

| Resource     | Purpose                                                       | Required Information                                                                                                                                |
| ------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content item | Owns the editorial lifecycle and publication state.           | Title, plain-text body, author, current revision, editorial status, optional publication time, linked asset IDs, and latest publication outcome.    |
| Review task  | Records an editor's review of one submitted content revision. | Content ID, submitted revision, assigned editor, due time, pending/approved/changes-requested/superseded outcome, decision note, and decision time. |
| Asset        | Tracks an uploaded attachment and its private stored object.  | Content ID, original filename, media type, size, storage identity, upload readiness, and uploader.                                                  |

Activity, outbox events, notification deliveries, and publication attempts are also durable
records. They need not all become user-authored resources or new framework abstractions.

References must resolve within the application. An asset cannot be attached to unrelated
content by forging an ID, and a review decision cannot approve a different or newer
revision. Storage and consistency mechanisms are technical-design decisions.

## Functional Requirements

### FR-01: Drafting and Editorial Lifecycle

Authors can create and edit their own drafts, attach ready assets, and submit them to an
editor with a review due time. Editors can manage content across the shared workspace.

The lifecycle distinguishes `draft`, `inReview`, `approved`, `scheduled`, `publishing`,
`published`, and `archived`. Publication failures are execution outcomes, not approvals.

| Action                    | Required Outcome                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Submit a draft            | Freeze the submitted revision, enter review, and create a linked review task.                               |
| Request changes           | Record the editor's note, close the current review, and return the item to draft.                           |
| Approve                   | Approve the current submitted revision and complete its review task.                                        |
| Revise before publication | Explicitly reopen to draft, invalidate approval, cancel any schedule, and require a new review after edits. |
| Schedule                  | Accept only approved content and a future publication time.                                                 |
| Reschedule or cancel      | Change or remove the pending schedule without leaving stale work authorized to publish.                     |
| Publish now               | Queue publication of approved content rather than performing storage side effects in the request.           |
| Archive                   | Remove an eligible item from active editorial views without erasing its history.                            |

Published content is read-only in this iteration; republishing revised editions is deferred.
Archiving does not race with active publication: either publication has not started and is
cancelled safely, or the archive command is rejected until the active attempt settles.

Review decisions, schedule cancellation, and publication must respect concurrent commands.
Stale revisions, duplicate submissions, and delayed events cannot create contradictory
authoritative state. If secondary records converge asynchronously, expose their pending
state and guarantee retryable convergence; do not treat them as independent authorities.

### FR-02: Review Queue and Permissions

Editors can view pending reviews, identify overdue tasks, open the exact submitted
revision, and approve or request changes with a note. Closed or superseded tasks remain
visible in history and cannot be decided again as if they were current.

Authors can read the shared workspace but mutate only their own drafts and attachments.
Editors control review decisions, publication scheduling, publication retries, and archive
actions. Worker identities have only the authority needed for their internal actions.
Enforce permissions on the backend; hidden buttons are not an authorization boundary.

Development identities are fixtures, not trustworthy production login. All application
services bind locally by default, and documentation must prohibit exposing fixture-auth
endpoints as a secure public deployment.

### FR-03: Publication and Object Storage

Publication means producing a durable, version-identified snapshot of approved content in
private object storage, including title, body, asset references, and publication metadata.
The application can retrieve and preview that snapshot; changing a draft must never change
an already published artifact. No external website or publishing API is required.

In local AWS integration mode, use LocalStack S3 and the actual queued worker path.
Record the attempt and artifact reference so the UI can distinguish queued, running,
successful, failed, and retryable work. Mark content published only after the artifact is
durable and its successful completion is recorded.

Retries and duplicate delivery must converge on one logical publication of the approved
revision. Handle a crash after object creation but before completion is recorded without
inventing a second publication. Recheck revision and schedule validity when work executes;
a delayed event from a cancelled schedule cannot publish the item.

### FR-04: Assets

Support upload, listing, preview/download where appropriate, and removal of draft
attachments. Use private objects, generated storage keys, validated file metadata, and
explicit file-size and media-type limits. Begin with PNG, JPEG, and PDF attachments up to
10 MiB each; arbitrary HTML or executable uploads are out of scope.

An interrupted upload must not appear as a ready asset. Invalid references or failed
uploads cannot silently become published attachments. Publication accepts only ready
assets, and published asset references remain usable even if editorial metadata is archived.
Define orphan cleanup and reset behavior without claiming uploads and database writes are
one atomic transaction. Malicious filenames must not control storage paths or render as HTML.

### FR-05: Scheduling, Notifications, and Recovery

Automatically request publication when an item's scheduled time becomes due. Also detect
overdue pending reviews and send a reminder. The technical design may choose recurring
due-item evaluation instead of provisioning one cloud schedule per content item.

Store publication times as unambiguous instants, display the user's local time zone, and
reject invalid or ambiguous input. Repeat schedule evaluation must not repeatedly publish
an item or flood reminders; define a bounded reminder policy in the technical design.

Deliver review-request, review-decision, publication-outcome, and overdue-review messages
through an asynchronous notification consumer to a durable local sink. Messages must be
inspectable in the UI and tied to the relevant item, event, and intended recipient. No
real email, Slack, or webhook provider is required.

Transient errors retry within explicit limits. Terminal failures are inspectable and
recoverable through a bounded, explicit retry/replay action or documented development
command. Repeated successful deliveries must not duplicate visible notifications. Describe
the scope of idempotency honestly rather than promising exactly-once external effects.

### FR-06: Operational UI

The first screen is the workbench, not a landing page. Provide these navigable views:

- Editorial board grouped by lifecycle, with title, author, and status filters.
- Content detail/editor with commands, attachments, review decisions, and activity.
- Editor review queue with assignment and overdue filters.
- Publication calendar and an accessible agenda/list alternative.
- Delivery/operations view for publication attempts, notifications, and failures.

These are application views, not a requirement to ship five generic framework widgets.
Use custom Angular components where necessary and JawStack resource components where useful.
The board and calendar must operate on real application state, not seeded presentation data
that diverges from the API. Drag-and-drop is optional; ordinary controls must cover all actions.

Provide loading, empty, validation, permission, conflict, background-pending, failure, and
success states. Preserve useful filter/date state in navigation and support keyboard use
and common desktop/mobile widths. Bound list reads and provide paging where appropriate;
do not require unbounded client-side scans of all content or all activity.

### FR-07: Activity and Observability

Record meaningful domain changes with actor and time. Detail views must explain the
sequence from submission through review, scheduling, publication, and notification.
Async failures must be distinguishable from command rejection.

Carry correlation identifiers from commands through events and workers. Use structured
logs and enough durable operational state to diagnose duplicate delivery, failed work,
and pending publication without requiring a production monitoring platform.

## Development Modes and Safety

| Mode                  | Purpose                                                   | Required Behavior                                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-memory             | Fast UI, domain, and contract development.                | No Docker, LocalStack account, real AWS credentials, or external providers required. Use deterministic development adapters for objects, background work, and time; do not build an AWS emulator. |
| Local AWS integration | Exercise persistence and asynchronous service boundaries. | Local HTTP ingress plus real JawStack AWS-facing adapters and bundled workers targeting LocalStack. Provision and verify the supported infrastructure reproducibly.                               |
| Real AWS              | Later deployment verification.                            | Existing tooling remains opt-in. No deployment or spend is authorized by this PRD, and real-AWS verification is not an iteration acceptance gate.                                                 |

### LocalStack Compatibility Gate

Before committing to the integration design, run a bounded feasibility spike for the
transaction -> DynamoDB stream -> outbox dispatcher -> EventBridge -> SQS -> Lambda worker
path, plus S3 object access and scheduled triggering. Record the tested image version,
plan, provisioning approach, configuration, and observed limitations in the technical design.

Current LocalStack releases require an account and auth token, including in CI. Hobby is
free for non-commercial use; its plan matrix excludes API Gateway HTTP/WebSocket APIs.
Use local HTTP ingress rather than requiring a paid tier or redesigning the AWS production
API solely for the emulator. See the [plan comparison](https://www.localstack.cloud/pricing)
and [distribution announcement](https://blog.localstack.cloud/localstack-single-image-next-steps/).

Scheduler emulation also has behavioral limits, including no failed-delivery retries.
Tests must distinguish verified application behavior from unavailable service fidelity.
See [Scheduler limitations](https://docs.localstack.cloud/aws/services/scheduler/#current-limitations).

These constraints were checked on October 31, 2026; revalidate them during the spike.
Do not use a paid trial to claim Hobby compatibility. If a required path is unsupported,
report it and revise the scope or design explicitly before implementation proceeds. Do
not silently substitute direct worker calls and label the integration verified.

### Isolation and Lifecycle

- Use dummy AWS credentials and validated local endpoints; fail closed on missing or unsafe configuration.
- Do not mount real AWS credential files or rely on a developer's default AWS profile.
- Prevent local commands and containerized workers from falling back to real AWS endpoints.
- Bind exposed services to loopback by default and keep LocalStack tokens out of Git and logs.
- Pin the tested emulator version and document container-runtime and resource prerequisites.
- Provide readiness checks and bounded timeouts; a stopped emulator must produce a clear error.
- Provide repeatable seed, reset, and teardown commands that affect only this application's local resources.
- Do not require paid emulator persistence: document restart behavior and make reseeding reproducible.
- Bound worker concurrency, retry attempts, scheduler frequency, upload size, and retained test data.

## Verification and Acceptance

Use unit/contract tests for domain rules and adapter behavior, Angular interaction tests
for key workflows, and automated local integration tests for AWS service boundaries.
Provide at least one browser-level walkthrough against the running application, with
desktop/mobile layout checks and no placeholder interactions.

| ID    | Acceptance Criterion                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01 | A developer can install and run the in-memory app from documented commands, seed data, and complete the workflow using distinct author/editor fixtures.                                                       |
| AC-02 | A non-Work Request content item, linked review task, and asset can be created and queried through public JawStack APIs or documented application extensions.                                                  |
| AC-03 | Invalid transitions, unauthorized edits, stale approvals, duplicate submission, and concurrent revision changes are rejected or converge without contradictory authoritative state.                           |
| AC-04 | Upload a valid asset, approve content, schedule it, trigger due evaluation, and observe a durable publication artifact and linked notification through the UI.                                                |
| AC-05 | Cancelling/rescheduling, reopening to draft, and delivering old events cannot publish an obsolete or unapproved revision.                                                                                     |
| AC-06 | Local AWS integration proves a committed command reaches a bundled worker through DynamoDB streams, outbox dispatch, EventBridge, and SQS; S3 and a scheduler-triggered job produce observable results.       |
| AC-07 | Re-deliver events and inject a transient failure plus a terminal failure. Verify bounded retries, inspectable failure state, explicit recovery, and no duplicate logical publication or visible notification. |
| AC-08 | Missing local endpoints, unavailable services, and inherited real credentials cannot result in an accidental AWS request. Reset and teardown leave unrelated resources untouched.                             |
| AC-09 | Board, detail, review queue, calendar/agenda, and operations views support the workflow, meaningful error states, keyboard use, and desktop/mobile layouts.                                                   |
| AC-10 | Work Requests tests, framework checks, isolated generated-app verification, and package checks still pass; public API changes have targeted regression coverage.                                              |
| AC-11 | Application and product docs distinguish implemented behavior, LocalStack-tested paths, emulator exclusions, and AWS behavior not verified in this iteration.                                                 |

Keep default unit tests independent of Docker and secrets. Run credential-free checks on
pull requests. Add a separately invocable local integration gate and a manual or explicitly
enabled PR integration job when a LocalStack token is available. Report a missing token
as not run, not as successful integration verification. Do not add a push-triggered build
or integration workflow. The gate must be run with evidence before declaring the iteration
complete even if it cannot run on untrusted fork PRs.

## Documentation Deliverables

- Application README with purpose, architecture, modes, prerequisites, commands, fixtures, and walkthrough.
- Local integration setup, supported-service matrix, isolation controls, reset/teardown, and troubleshooting.
- Product and package documentation for any new or changed framework contracts.
- Technical design mapping consumer requirements to existing APIs, required changes, and deferred abstractions.
- Implementation plan with reviewable phases and incremental verification evidence.
- Iteration outcome summary listing delivered consumer capabilities, framework changes, gaps, and unperformed AWS checks.

Do not advertise planned capabilities as shipped. Preserve the foundation documents as
historical records rather than rewriting their scope to include this iteration.

## Completion and Release Decision

The iteration is complete when the reference application is useful, its documented local
workflow and integration gate pass, regressions are addressed, and limitations are explicit.
It is not complete merely because files exist or another framework package was created.

A consumer-only outcome can merge without a framework version bump. Reusable framework
fixes or supported tooling may justify a coordinated package release, but require a
separate release decision and appropriate verification. Do not change package versions,
publish packages, create a tag, or add release automation solely to align with "Iteration 2."

## Technical Design Decisions

The technical design must settle resource schemas and access patterns; revision and
cross-resource consistency; command/form extension points; publication idempotency and
crash recovery; object-upload lifecycle; scheduling and reminder policy; local endpoint
isolation; emulator provisioning; and the automated test/CI strategy.

Those are implementation decisions within the product outcomes above, not permission to
expand into a generic CMS, rules engine, or AWS emulator. Identify any scope changes
explicitly during design review before turning them into implementation phases.
