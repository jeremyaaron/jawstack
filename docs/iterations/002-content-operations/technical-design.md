# Iteration 2 Technical Design: Content Operations

Status: reviewed as the basis for the [implementation plan](implementation-plan.md).
This is a proposed design, not a record of implemented or LocalStack-verified behavior.
The [PRD](prd.md) defines the product scope; material design changes still require review.

## Design Summary

Build a private Angular/TypeScript consumer in `apps/content-operations`, using the
existing workspace toolchain and JawStack package exports. Keep editorial policy, object
storage, query composition, and operational tooling in the application. Add only the
framework contracts identified below.

The principal decisions are:

- The content item is the editorial aggregate and sole authority for approval, attachment
  membership, schedules, and publication. Its commands use the existing single-resource
  executor and optimistic unit of work.
- Review tasks and asset resources are versioned, asynchronously maintained read models
  of content-owned facts. They are queryable resources, not independent authorities that
  can approve content or authorize uploads.
- All editorial state changes go through domain decisions and an atomic state/activity/outbox
  commit. Object storage is outside that transaction and uses an explicit recoverable lifecycle.
- Use a local Node HTTP ingress in both development modes. LocalStack mode runs the
  actual DynamoDB, outbox, EventBridge, SQS, Lambda, S3, and Scheduler integration path.
- Provision the bounded LocalStack lab with application-owned AWS SDK scripts, not a paid
  CDK asset-deployment feature. Separately synthesize and assert the application's CDK topology.
- Use recurring due-work evaluation, revision/generation checks, deterministic publication
  artifacts, and bounded retries. Do not introduce a workflow engine or multi-resource transaction DSL.
- Keep server definitions out of browser bundles. Angular consumes presentation metadata
  and browser-safe command schemas through a narrower, backward-compatible contract.

The compatibility spike is the first implementation gate. Drafting this document does not
authorize starting containers, using a LocalStack token, or deploying anything to AWS.

## Existing Contracts and Required Changes

The baseline offers `defineResource`, `defineCommand`, `executeCommand`, `ResourceState`,
`CommandUnitOfWork`, in-memory persistence, DynamoDB transaction builders, outbox adapters,
SQS adapters, Scheduler targets, Angular components, and a high-level CDK construct.

Important constraints observed in the current code:

- `CommandCommitInput` updates one resource state. It already supports activity, outbox,
  idempotency, and projection writes in the same commit.
- `CommandContext` has no dependency container. Resource factories can close over narrow
  application services; do not add a service locator to the framework.
- `defineState` currently describes scalar presentation fields. It does not validate an
  arbitrary nested `nextState`; application Zod schemas must validate complete domain state.
- `listProjection` and `getActivity` return arrays without a continuation contract. The
  AWS implementations make one query, so they are not adequate for bounded, complete app queries.
- DynamoDB projection sort keys include `sort` and `itemId`. Moving an item between sort
  positions requires an explicit old-key delete, unlike the current in-memory replacement behavior.
- The SQS adapter checks a processed marker before invoking a handler and writes it after
  completion. It does not exclude concurrent execution or make external side effects atomic.
- Angular inputs currently require executable `ResourceDefinition` objects. The demo also
  needs a Node HTTP shim because it imports the core runtime barrel into its browser graph.
- The DynamoDB idempotency repository needs a subject/command scope, and its unit of work
  needs the corresponding command name. Construct these per invocation, not once globally.
- Scheduler functions currently receive read-only table grants. Application jobs that issue
  commands require explicit additional grants.

| Owner                   | Proposed Work                                                                                                                                                | Compatibility and Verification                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@jawstack/core`        | Add page/query contracts and equivalent in-memory projection/activity query methods.                                                                         | Additive methods; existing command, resource, and array-returning APIs remain available. Test ordering, limits, range boundaries, and continuation. |
| `@jawstack/aws-runtime` | Implement the paged query contract using public DynamoDB keys/mappers.                                                                                       | No new data model required for baseline consumers. Test multiple DynamoDB pages, empty filtered pages, and cursor validation.                       |
| `@jawstack/angular`     | Add `ResourceUiDefinition`, narrow component/config inputs to that structural interface, and export a structured HTTP error type.                            | Existing `ResourceDefinition` values remain assignable. Test old components and presentation-only definitions with no `decide` function.            |
| `@jawstack/aws-cdk`     | Expose additive named worker bindings and named scheduler functions alongside existing arrays.                                                               | Preserve existing construct props, logical IDs, and arrays. Assert named lookup, S3 grants, and scheduler write grants in synthesis tests.          |
| Consumer                | Resource factories, scoped dispatch, schemas, editorial policies, materializers, publication, uploads, query composition, screens, and operational recovery. | No editorial logic in framework packages and no deep imports. Share contract tests across development adapters.                                     |
| Tooling                 | LocalStack lifecycle, SDK provisioning, integration verification, and browser verification.                                                                  | No push CI trigger, default Docker dependency, real credentials, or package version changes.                                                        |

Do not preemptively change the generator, replace the public CDK construct, add a generic
S3 package, or expand all scalar field metadata to describe arbitrary application state.
If implementation exposes another framework defect, document a focused change and test
it without silently expanding this table into a module roadmap.

The CDK additions are `workerBindingsByName` and `schedulerFunctionsByName`, both readonly
records keyed by declared worker/schedule name. Each worker binding contains
`workerFunction`, `queue`, and `deadLetterQueue`. Reject duplicate names during construction
rather than overwriting a binding. Application grants and DLQ collectors use these public
bindings; they do not inspect construct-tree children or depend on array ordering.

## Application Layout and Dependencies

```text
apps/content-operations/
  README.md
  package.json
  jawstack.config.ts
  compose.yaml
  src/
    shared/          # browser-safe Zod inputs, DTOs, presentation metadata
    domain/          # state schemas, resource factories, decisions, policies
    application/     # command dispatch, queries, jobs, upload/publication services
    adapters/
      memory/        # object store, outbox pump, fixture clock, operational store
      aws/           # guarded SDK clients, DynamoDB/S3 adapters
    http/            # loopback router, fixture identity, upload/download handlers
    aws/             # bundled outbox, worker, scheduler, and DLQ entrypoints
    web/             # Angular routes, feature screens, typed application client
    infra/           # CDK composition and shared infrastructure profile
  scripts/           # local lifecycle, seed, integration and recovery commands
  test/              # domain, contract, adapter, synth, and browser tests
```

Follow current Angular, Vite, Vitest, TypeScript, esbuild, pnpm, and lint conventions.
Pin new dependencies through the workspace lockfile when implemented; this design does
not request broad dependency upgrades. Use AWS SDK v3 clients in the application for S3
and lab provisioning. Use Playwright for browser tests.

Use [file-type](https://github.com/sindresorhus/file-type) for binary signature detection
and [the Temporal polyfill](https://github.com/js-temporal/temporal-polyfill) for explicit
time-zone/disambiguation handling. Signature detection is not malware scanning. Use
structured JSON and existing AWS SDK marshalling, not custom data formats or SQL parsing.

No new public package is necessary. The app remains private and does not become another
`create-jawstack` template in this iteration.

Loading `jawstack.config.ts`, inspecting the manifest, and synthesizing infrastructure must
not start servers/pumps, create containers, resolve credentials, or make service requests.
Keep configuration/resource construction pure; bind runtime services at explicit entrypoints.

## Runtime Composition

```text
Angular browser -> local Node HTTP application -> executeCommand
                                                  |
                                 state + activity + projections + outbox
                                                  |
        Memory: explicit outbox pump -> application event handlers
        LocalStack: DynamoDB stream -> dispatcher Lambda -> EventBridge
                                                        -> SQS -> worker Lambda
Scheduler -> due-work Lambda -> internal commands        -> DLQ -> failure collector
Publication worker -> private S3 objects -> completion command
```

Create a runtime explicitly as `memory` or `localstack`; there is no automatic backend
selection based on discovered credentials. Both modes share decisions, validation,
publication serialization, event handling, query semantics, and error mapping.

The memory object store uses bounded byte arrays. A development outbox pump processes
committed events with the same application handlers and retry policy, not an imitation
EventBridge/SQS implementation. The interactive app pumps automatically; tests explicitly
drain work and advance an injected clock. Data is volatile and reseedable.

The localstack runtime uses real framework AWS-facing persistence and messaging adapters.
The HTTP ingress stays on the host; its commands write to the same table that triggers the
bundled dispatcher and worker Lambdas. Direct Lambda invocation is permitted for diagnostics
but cannot substitute for proof of the stream/bus/queue integration path.

## Domain State and Bounds

Define full Zod schemas in the application, independent of presentation-field metadata.
Validate stored inputs before use and every resulting state before commit. Reject unknown
command properties, illegal enum values, malformed IDs, and oversize data at the boundary.

| Record                | Essential Fields and Authority                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contentItem`         | `authorId`, `title`, `body`, `revisionId`, `status`, bounded attachment slots, current review snapshot, approval, schedule, and publication state. Sole editorial authority.         |
| `reviewTask`          | Stable review ID, content ID, immutable submitted snapshot, assigned editor, due time, outcome/note, and `sourceVersion`. Materialized from content events.                          |
| `asset`               | Stable asset ID, content ID, filename/media type, expected/verified size, SHA-256, object key, uploader, lifecycle, and `sourceVersion`. Materialized from content attachment slots. |
| Publication attempt   | Publication ID, retry generation, attempt ID, source event/correlation IDs, start/end, outcome, and sanitized error. Durable operation history, not another editorial authority.     |
| Notification delivery | Deterministic delivery ID, source event, recipient, template/channel, rendered message, outcome, and time. The local sink is the delivery destination.                               |
| Failed delivery       | Consumer, logical operation key, immutable original envelope, retry generation, failure history, and recovery status. Enables bounded inspect/replay commands.                       |

Use generated opaque IDs; never derive storage paths from filenames or accept actor,
role, storage key, checksum, review outcome, or publication completion as trusted UI fields.
`ResourceState.version` is the optimistic concurrency counter. `revisionId` is a distinct
UUID regenerated when draft content or attachment membership changes, not when a reminder
or worker updates operational state.

Initial application limits:

- Title: 1-160 characters; plain-text body: at most 32 KiB UTF-8.
- At most 10 active attachment slots per content item, each at most 10 MiB.
- Review/decision notes: at most 2,000 characters; filenames: at most 255 characters.
- Submitted snapshot: at most 64 KiB serialized UTF-8; full content state: at most 160 KiB.
- Event payload: at most 80 KiB; messages carry object references, never asset bytes.
- Query page: 50 items by default, 100 maximum; at most 200 evaluated candidates per response.

Bound payloads before a transaction so limits fail as validation errors, not storage errors.
Do not embed an indefinitely growing list of reviews, deliveries, or attempts in content state.

## Commands and Consistency

### Single-Resource Authority

All author/editor actions affecting the lifecycle target `contentItem`. Draft attachment
registration/completion/removal also changes the content aggregate, so submission races
against upload completion or removal on the same versioned row.

Review and asset resources expose reads and internal `applySnapshot` commands. Those
commands emit their own declared materialization events, but no worker subscribes to its
own output. Public ingress rejects internal command names, regardless of caller headers.

This makes the three PRD resource types real queryable JawStack resources without requiring
three independently mutable authorities. A temporarily missing review/asset row does not
make the authoritative content fact disappear. The UI can show synchronization pending.

### Transition Rules

| Command                                                      | Actor and Preconditions                                                                          | Result                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `create`                                                     | Author or editor; valid title/body.                                                              | Draft owned by the resolved actor.                                                                   |
| `editDraft`                                                  | Owning author or editor; draft and expected resource version.                                    | Updated fields and new revision ID.                                                                  |
| `registerAsset`, `removeAsset`                               | Owning author or editor; draft.                                                                  | Add/remove a slot, change revision ID, emit a full asset snapshot.                                   |
| `completeUpload`                                             | Internal upload-verifier identity; matching draft, slot, and verified object metadata.           | Mark slot ready and emit updated asset snapshot.                                                     |
| `submit`                                                     | Owning author or editor; draft; all attached slots ready; editor fixture and future due time.    | `inReview`, new review ID, immutable submitted snapshot, and review-request event.                   |
| `approve`, `requestChanges`                                  | Assigned editor or another editor; matching current review ID and revision; `inReview`.          | Record decision; become `approved` or return to `draft`.                                             |
| `reopenDraft`                                                | Owning author or editor; `inReview`, `approved`, or `scheduled`.                                 | Invalidate review/approval/schedule, supersede pending review, return to draft with new revision ID. |
| `schedule`, `reschedule`, `cancelSchedule`                   | Editor; approved/scheduled content, matching approval.                                           | Set/change a future instant and generation token, or return to approved and invalidate the token.    |
| `publishNow`, `requestDuePublication`                        | Editor, or internal due-worker with matching due schedule.                                       | Atomically enter `publishing`, freeze publication intent, remove due projection, emit request.       |
| `claimPublication`, `completePublication`, `failPublication` | Internal publisher with matching publication ID, generation, and fencing token where applicable. | Update leased execution state, finalize published state, or record failed attempt.                   |
| `retryPublication`                                           | Editor; failed/stalled publication with no unexpired claim.                                      | Keep publication identity/snapshot, increment generation, enqueue a fresh request.                   |
| `recordReviewReminder`                                       | Internal due-worker; current pending review and unused UTC-day reminder slot.                    | Record one reminder and emit its notification event.                                                 |
| `archive`                                                    | Editor; draft, in-review, approved, scheduled, or published; never active `publishing`.          | Preserve history/objects, supersede pending review, remove active projections and schedule.          |

Only editor actions approve, schedule, publish, retry, or archive. Author ownership checks
run inside decisions using resolved auth and previous state. Internal workers receive
specific service roles, not editor privileges. Published content cannot be edited or reopened.

Entering `publishing` is the cancellation boundary, including while work is queued. A
cancel/reopen/archive that wins the content version race prevents that transition; one that
loses receives a conflict and cannot pretend publication was cancelled. A failed publication
remains locked to its approved snapshot until an explicit retry succeeds; abandoning an
in-flight external write is not implemented as an unsafe unlock.

### Request Version and Idempotency

Every non-create UI mutation includes `expectedVersion` in its strict application input.
The decision compares it to the loaded resource version; the unit of work still performs
the commit-time version condition. A browser loaded before another edit must receive `409`,
not have its edit applied to a newly loaded state. Internal callers reload and deliberately
retry eligible conflicts; do not automatically replay a user's stale edit.

Require an idempotency key on HTTP mutations. The browser retains one UUID for retries of
the same payload and creates another after user changes. Scope records by resource type,
command, and resolved subject, retaining the existing payload fingerprint's resource ID.
Keep records for seven days; expiry is enforced logically as well as by eventual TTL cleanup.

The application dispatch factory constructs a scoped `DynamoDbRepository` and
`DynamoDbCommandUnitOfWork` for each invocation, supplying the same command/subject context.
Use corresponding scoped wrappers around in-memory persistence. Never mutate a shared
repository's scope while requests are concurrent. On a competing idempotent commit, reread
the stored record and return its original response only if the fingerprint matches.

The same single-resource commit owns activity, projections, outbox, and idempotency. Do
not issue a second direct event publication or cross-resource write after returning success.

### Review and Asset Materialization

Each materialization event contains the complete bounded target snapshot, target ID, and
the next content resource version as `sourceVersion`. This includes the frozen submission
for review outcomes and tombstone information for removed assets. Do not publish only a
pointer that would require recovering an old revision from mutable content state.

The projector reads the target strongly, ignores an equal/older source version, and uses
the target's own optimistic commit to apply a newer snapshot. On conflict, reload and compare
again. An approval arriving before the submission event still creates a complete approved
review; the late submission cannot restore pending state. Deletions materialize tombstones,
not physical row deletion that permits an older event to recreate an active attachment.

A decision submitted from a review page always targets the authoritative content command
with content ID, review ID, revision, and expected version. Never authorize approval using
the materialized review's status alone. Overdue scheduling reads the authoritative due
projection, not an eventually synchronized review-task list.

### Event Contracts and Subscriptions

Declare app events with schema version 1 and Zod-validated payloads. Content lifecycle
events use the `contentItem` resource ID, correlation ID, actor, and command request ID
from the framework envelope. Worker-issued commands preserve the incoming correlation ID
and use the incoming event ID as causation through their request context. Never put tokens,
object bytes, or raw exception stacks in payloads.

| Consumer              | Subscribed Facts                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `materializeReview`   | Review requested, decided, or superseded; each carries a complete review snapshot and source version.             |
| `materializeAsset`    | Asset registered, verified ready, removed, or expired; each carries a complete asset snapshot and source version. |
| `publishContent`      | Publication requested or explicitly retried, with publication ID and generation.                                  |
| `deliverNotification` | Review requested/decided, review reminder recorded, and publication succeeded/terminally failed.                  |

Use explicit declared event types such as `contentItem.reviewRequested` and
`contentItem.published`, not wildcard subscriptions to all state changes. Transient failed
attempts are operational records; send a failure notification only when a delivery cycle
becomes terminal. `reviewTask.snapshotApplied` and `asset.snapshotApplied` are not inputs
to their materializers. A dedicated application/stage event bus scopes the rules, and
handlers validate the expected source to avoid cross-consumer traffic. Projection generation
is not a new automation engine.

## Persistence and Query Design

### Table and Projections

Use one application DynamoDB table with the existing JawStack state/activity/outbox/
idempotency keys and outbox `GSI1`. Use exported mappers and transaction builders rather
than importing package-private utilities. The app may add typed auxiliary operation records
and queries without adding new item kinds to every JawStack consumer.

| Access Pattern       | Partition/Projection                                                     | Sort and Update Rule                                                               |
| -------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Content board/list   | `contentItem.list`, optionally `contentItem.status.<status>`             | Immutable creation instant + content ID; replace data in place.                    |
| Scheduled calendar   | `contentItem.calendar`                                                   | Scheduled instant + content ID; query requested UTC instant range.                 |
| Due publications     | `contentItem.duePublication`                                             | Scheduled instant + content ID; delete when schedule changes or publishing begins. |
| Due review reminders | `contentItem.dueReview`                                                  | Due instant + content ID; current review ID is in projection data.                 |
| Review queue/history | `reviewTask.list`, `reviewTask.pending`, `reviewTask.editor.<fixtureId>` | Stable creation/due sort as appropriate; materializer maintains membership.        |
| Per-content assets   | `asset.content.<contentId>`                                              | Stable registration instant + asset ID, including readiness/tombstones.            |
| Item activity        | Existing resource partition, `ACT#` prefix                               | Existing activity key order with continuation.                                     |
| Operation history    | App-owned `OPS#<kind>` partitions and per-content reference rows         | Fixed attempt/delivery identity; no endlessly appended root arrays.                |

Each decision that changes a projection partition or sort explicitly deletes the prior
physical key and writes the replacement in the same transaction. Build old keys from the
previous authoritative state. Deduplicate actions when old/new keys are identical; never
put and delete the same key in one transaction. Require adapter parity tests for moves.

App-owned operation writes use a small application unit-of-work decorator: compose the
exported `buildCommandTransactWriteItems` result with a bounded list of typed operation
records derived from the validated decision. Persist attempt history with the corresponding
content transition. Mirror this atomically in the memory adapter. This is not a public
arbitrary transaction DSL, and it must not bypass the primary version or idempotency checks.

DynamoDB permits up to 100 distinct transaction actions and does not allow two actions on
one item. Enforce a lower app budget of 60 actions and reject excess before sending. See
[TransactWriteItems](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html).

### Paged Read Contract

Add reusable query types without exposing raw DynamoDB requests:

```ts
type Page<T> = Readonly<{ items: readonly T[]; nextCursor?: string }>;

type ProjectionQuery = Readonly<{
  projectionName: string;
  limit?: number;
  cursor?: string;
  sortFrom?: string; // inclusive
  sortBefore?: string; // exclusive
  descending?: boolean;
}>;

type ActivityQuery = Readonly<{
  resourceType: string;
  resourceId: string;
  limit?: number;
  cursor?: string;
}>;
```

Expose `queryProjection` and `queryActivity` through a new query-repository interface and
both adapters. Keep legacy methods and callers compatible. Memory ordering and cursor
boundaries must match the physical keys used by DynamoDB, including timestamp ties.

Only application query handlers select permitted projection names. HTTP callers cannot
choose arbitrary partitions, indexes, expressions, or exclusive-start keys. A bounded,
versioned base64url cursor contains the continuation key and query-scope fingerprint;
validate its shape, size (4 KiB maximum), resource/partition, range, direction, and filter
scope before use. A cursor is not an authorization credential.

Board title/author filters are simple normalized substring/equality filters, not full-text
search. Query the narrowest status partition, evaluate at most 200 candidates, and return
a continuation even when a page has no matches. Continue until enough matches or the
budget is reached; do not drop DynamoDB continuation keys. Calendar endpoints accept at
most 42 displayed days per request. Activity and operations are also explicitly paginated.

## Publication Protocol

### Stable Intent and Artifact

`publishNow`/`requestDuePublication` creates a publication ID once, freezes the approved
snapshot, approved revision, schedule generation if any, and `requestedAt`, and sets
generation 1. A retry changes the generation, not the publication ID or artifact contents.

Serialize a schema-versioned JSON artifact with an explicit field order, normalized UTC
timestamps, and assets sorted by ID. Use the intent's timestamp, never a worker's current
time. Compute SHA-256 over those bytes. The private key is
`publications/<contentId>/<publicationId>/snapshot.json`; it contains no user filename.

The worker uses `PutObject` with `IfNoneMatch: "*"`. On an existing object, read/verify its
digest and publication identity and treat matching content as a recoverable prior write.
A mismatch is terminal corruption, not permission to overwrite. Conditional-write conflict
and transient service errors retry; do not interpret every storage error as "already exists."
See [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).

### Claim, Write, and Complete

1. Strongly load content. A different publication ID/generation, obsolete schedule, or an
   already completed intent is either rejected as stale or acknowledged as already complete.
2. Claim the active generation through an internal content command, recording an attempt
   ID, random fencing token, and a 90-second lease. An unexpired competing claim is retryable,
   not a successful no-op that may mark the source event processed.
3. Write or verify the deterministic artifact. Do not hold a database transaction open.
4. Complete through another internal command, checking ID, generation, token, and lease.
   Commit published state, artifact metadata, activity, operation history, and outcome event.
5. Only then allow the SQS adapter to mark the event processed.

On failure, record a sanitized failed attempt if the claim is still current, release the
claim, and throw so SQS retries. A stale worker cannot complete or fail a newer claim. If a
lease expires after an object write, a new owner writes/verifies identical bytes and
completes; the old owner cannot overwrite the authoritative result. Treat storage digest
mismatch and invalid snapshots as non-recoverable until an operator addresses the cause.

All `publishing` content remains locked against editorial changes, even after a lease
expires. Thus lease expiry cannot authorize a new draft while an old process might still
write. The artifact is private and visible through the app only after successful completion.
The remaining S3/database boundary is recoverable, not exactly-once external execution.

Each actual claim attempt gets a new attempt UUID. Reuse it only for retries of that same
claim request; a later delivery after lease expiry needs a new attempt UUID and idempotency
key. Completion/failure keys include publication ID, generation, attempt ID, and action.
Otherwise command idempotency could replay an expired claim forever instead of allowing
recovery. A successful claim alone is not a processed-worker marker.

## Asset Protocol

All upload/control requests use local HTTP ingress; do not give the browser presigned write
URLs that can overwrite an approved object after validation.

1. `registerAsset` adds a pending slot to a draft with generated asset ID/key, uploader,
   claimed filename/type/size, and a one-hour upload deadline. Emit an asset snapshot.
2. `PUT /api/uploads/<contentId>/<assetId>` resolves fixture identity, strongly loads the
   content/slot, checks ownership and draft status, and accepts raw bytes with a 10 MiB
   streamed limit. Allow at most two concurrent uploads; reject excess with a retryable response.
3. Detect allowed PNG/JPEG/PDF signatures, compute SHA-256, and verify actual size. Ignore
   client-provided checksums as authority. Store at `assets/<contentId>/<assetId>/original`
   conditionally, with type/digest metadata. If the key exists, accept only matching bytes.
4. Invoke internal `completeUpload` with verified metadata. Commit only if the slot is still
   pending and the content is still a draft. On a version conflict, reread and recheck rather
   than blindly applying the old decision. Repeated matching completion is idempotent.
5. Submission freezes ready slots into the approved snapshot. It rejects any pending slot.
   `removeAsset` works only in draft, invalidates the slot, and emits a tombstone; no user
   command deletes bytes referenced by an approved/published snapshot.

A crash after object creation leaves an unready slot. Retrying the same upload can verify
the object and complete it; an expiry command can retire abandoned slots. A removal that
wins the content version race prevents later completion and leaves garbage for cleanup.

Run bounded orphan cleanup only for objects older than 24 hours whose authoritative slot
is removed/expired. Logical slot expiry is checked at command time. Keep tombstones at least
as long as objects exist, and never delete from an eventually consistent asset read alone.
Retain approved/published objects until an explicit local reset; automatic archival cleanup
must not break them. The app is a bounded development system, not an unbounded retention promise.

Serve images through authenticated local routes with correct media types and `nosniff`.
Serve PDFs as attachments, not embedded active documents. Escape filenames and body text;
render publication JSON as application views, not user-supplied HTML. Signature checks do
not constitute content sanitization or antivirus protection.

## Scheduling, Notifications, and Recovery

### Due-Work Jobs

Use EventBridge Scheduler `rate(1 minute)` targets for due publication/review evaluation and
outbox sweeping. No per-item cloud schedules are needed. A tick processes at most 50 due
items and stops after 20 seconds; SDK requests have bounded timeouts/retries. Persist a
continuation checkpoint per job so a repeatedly failing oldest item cannot starve later work.
After a pass completes, restart from the oldest due item on the next tick.

Checkpoint state includes a fixed `passCutoff` instant and the cursor for that pass. Keep
the upper query bound fixed until the pass ends so a clock change does not invalidate its
cursor. A short conditional job lease prevents overlapping ticks from overwriting progress;
after expiry a successor resumes the saved cursor. New due work is picked up in the next
pass, and deleted continuation items are handled by key position, not by requiring the
old item to still exist.

Before issuing an internal command, reload content strongly and verify due time, review/
schedule ID, revision, and generation. Repeating a tick cannot enqueue two publications
because the same content row transitions from scheduled to publishing once.

Reminders are limited to one per UTC day for each still-pending review, starting after its
due instant. Store `lastReminderDay` on the authoritative current review and emit the
notification in the same command. Completing/superseding the review removes its due projection.
The UI shows local times, but reminder deduplication uses the documented UTC-day boundary.

Commands accept ISO timestamps with an explicit offset. The UI converts a local date/time
plus IANA time zone using Temporal with disambiguation set to `reject`; nonexistent or
ambiguous daylight-saving times require correction rather than silent adjustment. Server
validation enforces future times with its clock and stores normalized UTC instants.

### Notification Sink

Subscribe to review request/decision, publication success/failure, and review-reminder
events. A delivery ID is derived from the original source event ID, recipient, and template
version. In memory use an atomic map insertion; in DynamoDB use a conditional transaction
for the delivery record and its operation/query records.

Because the durable local sink is the destination, duplicate executions can converge on one
visible delivery without calling any external provider. The worker returns successfully
only after that record is committed. A later email/Slack adapter would need a new delivery
contract; do not claim these guarantees apply to arbitrary external effects.

### Failure Collection and Replay

Use SQS worker queues with DLQs, three receives per delivery cycle, visibility 180 seconds,
Lambda timeout 30 seconds, and maximum concurrency 2. Keep SDK attempts at most 2 and
explicitly bounded inside that runtime. Local integration uses batch size 1 for clear
failure injection; contract tests still cover the baseline adapter's whole-batch retry
behavior. Partial batch reporting is not introduced in this iteration. AWS documents the
distinction in [SQS error handling](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html).

Attach an application DLQ collector to each worker DLQ. It first persists a deterministic
failed-delivery record and marks the matching publication generation failed/stalled where
applicable; only then acknowledge the DLQ message. Do not let a late DLQ record replace a
newer retry or successful publication. A collector failure leaves the original message for
retry and logs the fault rather than dropping it or spawning an infinite DLQ chain.

The operations view shows queued/running/succeeded/failed/stalled publication state,
notification deliveries, and materialization failures. A lease-expired job is shown as
stalled, not definitely failed, until reconciled. A collector seeing a live matching lease
defers finalization until that claim expires or completes.

Provide editor `retryPublication` and a development `jobs:inspect` / `jobs:replay <failureId>`
command for other consumer failures. Replay loads a validated stored envelope and an
allowlisted consumer; it never accepts arbitrary URLs, queue names, or executable payloads.
Limit manual recovery to three cycles per failure record and record who initiated it.

Persist the replay request and its outbox entry atomically with recovery state, so a CLI
crash cannot lose it. Use a new transport event ID and stable `originalEventId`/business key.
Store the original ID in the application's validated payload delivery metadata, preserving
the public framework envelope shape. Notification deduplication uses that original ID
when present, not the replay transport ID.
Review/asset source versions, notification delivery IDs, and publication identity retain
their original deduplication meaning. Publish retries advance the authoritative generation
before enqueueing; old deliveries cannot claim the new generation.

Keep source messages for four days and DLQs for fourteen days. Retain completed worker
markers for seven days, but keep business-level deduplication records for the life of the
development dataset. Marker TTL expiry alone must not allow a second publication/delivery.

## HTTP and Angular Design

### Ingress and Identity

Use a small Node HTTP router and existing API success/error envelope shape. Application
commands call public `executeCommand` through the scoped dispatch service; application
queries and uploads use explicit handlers. Do not copy the framework executor or expose
its entire internal registry as an unrestricted HTTP router.

Resolve `x-content-ops-fixture` to a fixed server-side directory containing two authors and
one editor. Ignore caller-supplied subject/roles/claims headers. Internal service identities
are constructed in process and cannot be selected from an HTTP header. Reject non-local
configuration and reject cross-origin mutation requests; development identity is still not
secure authentication against another local user or process.

Bind API port 4327 and Vite port 4326 to `127.0.0.1`, with a Vite `/api` proxy. Fail clearly
if configured ports are occupied; support an explicit port override in browser-test setup.
Use same-origin routes rather than broad CORS. Validate `Host`/`Origin`, bound JSON requests
to 256 KiB, and keep upload limits separate. Never return stack traces, raw AWS failures,
credentials, bucket configuration, or uploaded bytes in diagnostic error bodies.

### Routes and Client

| Route                                                                  | Purpose                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `GET /api/health`, `GET /api/manifest`, `GET /api/fixtures`            | Readiness, public metadata, and fixed development identities.     |
| `POST /api/resources/contentItem/commands/create`                      | Create through normal command dispatch.                           |
| `POST /api/resources/contentItem/:id/commands/:command`                | Allowlisted user commands only; idempotency key and strict input. |
| `GET /api/content`, `/api/reviews`, `/api/calendar`, `/api/operations` | Typed, filtered, paginated application queries.                   |
| `GET /api/resources/:type/:id`, `/api/resources/:type/:id/activity`    | Allowlisted resource reads and paginated activity.                |
| `PUT /api/uploads/:contentId/:assetId`                                 | Verified, bounded attachment upload.                              |
| `GET /api/assets/:assetId/download`, `/api/content/:id/publication`    | Authorized downloads and committed artifact previews.             |

An application `ContentOperationsClient` implements the relevant `JawStackApiClient`
methods and adds typed query/upload operations. Export `JawStackApiError extends Error`
from Angular with `code`, HTTP status, `details`, and correlation ID so conflict/permission
states do not depend on parsing English messages. Preserve existing `Error` compatibility.

Add `ResourceUiDefinition` with name/title, scalar state metadata, views, and command
presentation (`title`, roles, input schema, create flag). It excludes execution functions,
workers, and schedules. Narrow Angular component/config inputs to this structural type;
existing complete resource definitions still satisfy it. Share browser-safe command Zod
schemas and UI definitions with server factories, not instantiated server resource objects.

Concretely, its state/views fields use the existing public metadata types, while its
command map contains only `Pick<CommandDefinition, "title" | "roles" | "input" | "create">`.
Use type-only core imports in shared/client code. Browser-build checks must prove that
neither the Node HTTP shim nor AWS/CDK libraries or server decision factories are required.

Use custom Angular reactive forms for uploads, review selection, scheduling, and conflict
handling. Reuse the shell, badges, error panels, command controls, and simple resource form
where appropriate. Build a custom paged activity view rather than making the existing
timeline pretend it loaded all history. Do not broaden a generic form engine to cover every
application interaction.

### Screens and State

- `/content`: responsive editorial board; status/title/author filters in query parameters;
  explicit load-more controls and a compact list layout on narrow screens.
- `/content/new`, `/content/:id`: editor, attachment progress, review snapshot, lifecycle
  commands, publication outcome, and paged activity. Warn before abandoning unsaved edits.
- `/reviews`: editor/overdue filters, snapshot inspection, decision note, and direct navigation.
- `/calendar`: month/date/time-zone state in the URL, scheduled-item links, and agenda toggle.
  Use a CSS-grid month view; no drag/drop or custom date parsing engine.
- `/operations`: publication attempts, notification sink, failure details, and eligible retry actions.

Use Angular signals and small feature services rather than introducing a global state
framework. Poll pending operations every two seconds while the relevant view is visible,
back off to ten seconds after one minute, and stop when settled or the tab is hidden.
Commands disable duplicate submission but preserve the idempotency key on network retries.
On `409`, retain the user's draft locally and offer refresh/review, not silent overwrite.

Provide empty/loading/error/permission/synchronization states, keyboard labels and focus
management, accessible calendar/list alternatives, and fit checks at 1440x900 and 390x844.
Use a maintained Angular-compatible Lucide package for tool icons. Asset thumbnails come
from actual uploads/seed assets; do not substitute decorative imagery for operational data.

## LocalStack Lab and Infrastructure

### Compatibility Gate and Provisioning Choice

The [Hobby plan matrix](https://www.localstack.cloud/pricing) excludes API Gateway HTTP APIs.
The [CDK integration documentation](https://docs.localstack.cloud/aws/connecting/infrastructure-as-code/aws-cdk/)
also identifies asset deployment as a paid-plan feature. Therefore the proposed Hobby lab
uses SDK provisioning and direct Lambda ZIP uploads rather than `cdk deploy`, `cdklocal`,
paid hot reload, or a trial. This is local integration infrastructure, not a second general IaC tool.

Build ESM Node 22 Lambda ZIPs with esbuild and a standard ZIP library. Provision table,
stream mapping, bus/rules, queues/policies, execution roles, functions, schedules, and bucket
with AWS SDK calls and explicit names. Wait for each service resource to become ready.
Use the same application infrastructure profile and built handlers in provisioning and
synthesis tests. Tag and record created resources in a local instance manifest.

The application CDK composition uses `JawStackResourceWorkflowApp`, adds a private S3 bucket,
and uses new named bindings to grant publication-object access to the publisher, asset
upload/download access to ingress, and table writes to due jobs.
Retain existing baseline logical IDs/behavior. Provide an API Lambda wrapper around the
application JSON router for synthesis, but no app real-AWS deploy command or production-auth
claim. Do not alter production HTTP API type to match a local emulator.

Keep the fixture auth mode explicitly `dev`, never relabel it `external` just to pass a
deploy check. App launchers and runtime entrypoints reject real-AWS mode/non-local stages;
the synthesis-only API wrapper does not enable a deployable public fixture-auth service.
No new authentication or production-readiness guarantee is inferred from successful synth.

Synthesis assertions compare the supported topology/configuration with the local profile.
SDK provisioning does not verify CloudFormation deployment, API Gateway routing, CDK asset
delivery, IAM enforcement, or a production frontend. Document those exclusions explicitly.

The first implementation gate must prove, using a Hobby entitlement:

1. A transactional command creates state, activity, projection, idempotency, and outbox records.
2. A real DynamoDB stream event invokes the bundled outbox dispatcher.
3. EventBridge routes the emitted event to SQS and invokes the bundled worker.
4. S3 conditional creation/readback and duplicate delivery converge on the intended artifact.
5. Scheduler invokes a bundled due-work target and causes an observable domain outcome.
6. A failed worker message reaches a DLQ and the failure collector records it durably.

Use a minimal test resource and real framework adapters in this harness; it must not depend
on the finished editorial application or the proposed Angular/query APIs. Evolve the passing
harness into the app integration gate rather than retaining a disconnected throwaway demo.

Record exact image tag/digest, entitlement, architecture, durations, topology differences,
and pass/fail/not-run evidence in `docs/iterations/002-content-operations/localstack-evidence.md`
when the spike actually runs. Select and pin the tested image then; do not invent a tested
version in this draft. Bound the spike to two reviewable implementation phases; if a critical
path fails, stop dependent integration work and bring the explicit scope/design change for
review. Lack of a token is not successful verification.

### Credential and Endpoint Isolation

Use a dedicated Compose project and Docker network named from an app instance ID. Publish
only `127.0.0.1:4566`; expose additional ports only if the spike proves they are needed.
Host SDK clients use `http://127.0.0.1:4566`; Lambda clients use the declared Compose service
endpoint on that network, not loopback inside the Lambda container.

Construct every SDK client in the application's guarded factory with explicit `test`/`test`
credentials, region `us-east-1`, endpoint, bounded retry/timeout settings, and path-style S3.
Reject inherited real AWS credentials, profile/role/web-identity/container credential
settings, and unknown endpoint overrides in local launchers. Set metadata credential lookup
off and do not load the shared AWS credential/config files. Do not forward the developer's
entire environment into child processes or Lambda configuration.

Validate endpoint protocol, host, port, and absence of userinfo/query/fragment. Only the
declared loopback endpoint or exact internal service endpoint is allowed. Validate SQS URLs
returned by the emulator too; configure the tested local SQS URL strategy rather than
following an unexpected AWS URL. Reject redirects and add a final SDK request-handler check
of each outgoing hostname/port before opening a connection. The factory has no AWS-default
branch. Host-side DNS checks reject non-loopback resolutions for any allowed local alias.

Negative tests use an instrumented transport to prove that AWS/default endpoints and
credential fallbacks cause zero outbound requests, not merely an eventual authentication
failure. The app does not promise that arbitrary manually written AWS SDK code is isolated.

Pass `LOCALSTACK_AUTH_TOKEN` only to the emulator via an untracked environment file or CI
secret. It is not an AWS credential, browser variable, Lambda environment variable, or log
field. The lab still needs network access for authentication/image downloads; it is not an
air-gapped environment.

LocalStack Lambda execution requires Docker access; mounting its socket has substantial
host privileges. Use only the trusted, pinned emulator image on a development machine or
isolated CI runner, with no real credential-directory mounts. This is not a container
security sandbox. Verify container networking on the host architecture rather than assuming
the current ARM64 CDK Lambda default matches every CI runner. See the official
[installation](https://docs.localstack.cloud/aws/getting-started/installation/) and
[Lambda documentation](https://docs.localstack.cloud/aws/services/lambda/).

### Lifecycle and Operations

Proposed app scripts, implemented only in later phases:

| Command                       | Contract                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `dev:api`, `dev:web`          | Run the default in-memory app on loopback.                                                                     |
| `local:up`                    | Validate configuration/token, start the dedicated Compose service, and wait at most 120 seconds for readiness. |
| `local:provision`             | Build bundles and create the named lab resources; reject incompatible existing ownership/configuration.        |
| `dev:api:local`               | Start the host ingress with the validated LocalStack runtime.                                                  |
| `seed`                        | Idempotent deterministic seed through normal application commands; explicit runtime selection.                 |
| `verify:local`                | Run the real integration scenarios with bounded waits and write sanitized evidence.                            |
| `local:reset`                 | Require confirmation, quiesce work, delete only owned resources/objects, reprovision, and optionally reseed.   |
| `local:down`                  | Stop/remove this Compose project and its runtime containers without touching another project's resources.      |
| `jobs:inspect`, `jobs:replay` | Inspect/recover allowlisted application delivery failures with bounded history.                                |
| `test:browser`                | Run Playwright with managed local servers and isolated test data.                                              |

Use a validated instance ID in names, manifest ownership markers, and tags. Never delete
resources just because their names have a broad prefix. Verify exact ownership before
reset, stop schedules/event mappings, drain/disable workers, delete objects and bucket,
and then remove queues/functions/table in dependency order. On interruption, retain the
manifest and report cleanup still required. Normal teardown also stops spawned Lambda
containers belonging to the project; verify that behavior during the spike.

Hobby persistence is not required. Treat container recreation as a fresh dataset and make
seed/reset reproducible; do not disguise a paid persistence dependency as a Docker volume.
Use seven-day log retention, explicit concurrency limits, and modest seeded data. Do not
automatically pull `latest`, upgrade the image, start a cloud trial, or invoke real AWS.

Scheduler emulation does not provide AWS-equivalent delivery retry behavior. Test the
application's idempotent due-work logic and DLQ/recovery handling separately from unavailable
service fidelity, and label manually triggered local scheduler executions as such. At least
one integration test must observe an automatic rate-triggered invocation. See
[Scheduler limitations](https://docs.localstack.cloud/aws/services/scheduler/#current-limitations).

## Verification Strategy

| Layer              | Required Coverage                                                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain             | Transition matrix; role/ownership; expected version; bounded payloads; immutable review snapshots; invalid reference IDs; stale review and schedule generations; DST ambiguity.                           |
| Adapter contracts  | Scoped idempotency including concurrent replay; transaction rollback; projection moves without duplicate keys; query paging/ties/filter budgets; memory/AWS equivalence.                                  |
| Worker contracts   | Concurrent duplicate invocation; processed-marker gaps; fencing/lease expiry; object-created-before-crash; existing-object digest mismatch; out-of-order projectors; replay generations.                  |
| Upload contracts   | Size/type/signature limits; malicious names; interrupted transfer; duplicate bytes; removal/completion/submission races; orphan cleanup that preserves approved objects.                                  |
| Local integration  | Real transaction/stream/bus/queue/worker/S3 path; automatic scheduler tick; DLQ collector; transient failure then success; terminal failure then explicit recovery; endpoint-negative and teardown tests. |
| Browser            | Distinct author/editor workflow; custom forms; board/filter/navigation; review snapshot; upload and preview; calendar/agenda; pending/failure/conflict states; desktop/mobile screenshots.                |
| Existing consumers | Work Requests tests/build; framework typecheck/lint/test/build; isolated generated-app installation/typecheck/test/synth; package guard and tarball dry runs.                                             |

Inject failures through test-only server/worker configuration keyed to an exact operation
ID. No UI-accessible "fail arbitrary jobs" endpoint or production chaos dependency.
Check final authoritative state and artifact/delivery counts, not just HTTP status or a
successful `PutEvents` response. Save bounded redacted diagnostics on failures.

Default `pnpm test` remains Docker/token-free. Do not add integration files to Vitest's
default `**/*.test.ts` discovery; use a separate integration config or script. Browser tests
run against the memory app without credentials; an explicit local browser scenario can
also exercise the verified LocalStack stack.

Retain pull-request and manual CI triggers only. Run normal checks and the memory browser
gate on PRs. A separate manual workflow or explicitly enabled trusted-PR job runs
`verify:local` with a LocalStack token on an isolated runner. Do not expose secrets to fork
code or use `pull_request_target` to execute untrusted changes. When unavailable, report
integration as not run; the iteration remains incomplete without a recorded successful gate.

Do not deploy to AWS during design or routine tests. CDK synthesis is evidence about
templates, not a claim that a real stack deployed or that production auth is implemented.

## PRD Traceability and Completion

| PRD Acceptance | Design Evidence                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01, AC-02   | Private consumer, shared domain runtime, three typed resources, fixture workflow, and documented commands.                                         |
| AC-03, AC-05   | Single editorial authority, expected versions, immutable review snapshots, projection source versions, schedule generations, and publication lock. |
| AC-04, AC-06   | Upload/publication protocols plus observed stream/bus/SQS/Lambda/S3 and scheduled outcomes in the Hobby lab.                                       |
| AC-07          | Deterministic artifacts, fenced execution, bounded retries, DLQ persistence, recovery generation, and stable notification IDs.                     |
| AC-08          | Guarded clients/transport, explicit credentials/endpoints, ownership manifests, and negative/teardown tests.                                       |
| AC-09          | Five operational screens, paged queries, browser-safe metadata, custom forms, and browser layout/interaction checks.                               |
| AC-10          | Additive framework contracts and existing consumer/generated-app/package regression gates.                                                         |
| AC-11          | App README, local evidence/coverage matrix, product contract updates, and an iteration outcome summary.                                            |

The implementation plan should lead with feasibility, then scoped framework contracts,
domain/persistence, application services, UI, and end-to-end evidence. Split work into one
code -> user review -> user commit cycle per phase; no automatic commits or release actions.

Do not create a release version just to match the iteration. Keep the baseline template
working, document each public API change, and decide publication/versioning only after the
consumer and verification evidence justify it. Production authentication, frontend hosting,
generic capability modules, and real-AWS deployment remain deferred.
