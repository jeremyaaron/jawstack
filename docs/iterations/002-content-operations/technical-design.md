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

Implementation note: the Phase 0-1 gate has since passed on the pinned Hobby configuration;
see [observed evidence](localstack-evidence.md). Its failure-test worker/collector profile
uses 5-second timeouts and 30-second visibility to observe three receives promptly. The
30-second/180-second application design below remains unchanged and unimplemented.

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

Phase 5 implements the records with exact, case-sensitive declaration names. Schedule keys
are schedule names rather than target-handler names, so a shared handler does not collapse
multiple schedules. Workers and schedules have separate name namespaces. Both maps and
worker-binding wrappers are frozen, with no object-prototype fallback for missing names;
the underlying CDK constructs remain mutable for application composition. Unknown lookups
return `undefined` and application composition must check them explicitly.
The public lookup value types include `undefined` independently of the consumer's
`noUncheckedIndexedAccess` setting.

Construction preflights duplicate names across resources and requires own, nonblank handler
entrypoint entries before creating infrastructure. Existing props, arrays/order, logical IDs,
physical naming, retry/concurrency settings, and default grants remain unchanged. In
particular, scheduler table-write access and DLQ collectors are application-owned additions,
not automatically enabled framework behavior. Synth tests target S3 permissions, scheduler
write grants, and a collector's event-source mapping through the public bindings; a baseline
logical-ID/type snapshot was captured before implementation. These checks do not deploy
resources or establish live IAM/runtime delivery behavior.

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

Phase 6 lands the headless editorial portion as strict, bounded schemas and pure factories
in `src/shared`/`src/domain`. It uses UUID content/revision/review IDs and four fixed local
author/editor fixtures. Bind core resource-ID generation to UUIDs; revision/review IDs are
generated lazily inside decisions with an injectable test generator. Identity policy
intersects fixture roles with resolved auth roles and rejects unknown/external fixture
identities. Browser metadata imports Angular/core types only, not server factories or SDKs.

Current state validates editorial lifecycle, bounded review/attachment snapshots, approval,
and Phase 10 scheduling/publication execution state. Phase 11 adds verified publication-object
execution; Phase 12 adds due work/local-time conversion. Editorial guard tests
enter scheduled/publishing/published through real domain commands with trusted test metadata;
separate publisher tests verify artifact creation and recovery.
Input titles are trimmed; stored titles must already be canonical. Body whitespace is
preserved, Unicode is validated, and serialized snapshot/state/event byte bounds apply in
addition to the raw UTF-8 body limit. An unchanged save advances resource version without
inventing a new revision; reopening always invalidates the revision.

## Commands and Consistency

### Single-Resource Authority

All author/editor actions affecting the lifecycle target `contentItem`. Draft attachment
registration/completion/removal also changes the content aggregate, so submission races
against upload completion or removal on the same versioned row.

Review and asset resources expose reads and internal `applySnapshot` commands. Those
commands emit their own declared materialization events, but no worker subscribes to its
own output. Public ingress rejects internal command names, regardless of caller headers.

Phase 6 review primitives are `createSnapshot` (create) and `applySnapshot` (update), because
core definitions require commands and the executor separates creation from optimistic
update. Both require the dedicated review-projector identity; neither is an editorial UI
command, and the review UI command map stays empty. They preserve the immutable submission
and require increasing content `sourceVersion`; equal/older facts reject without a commit.
Phase 9's shared handlers read/ignore stale facts, reload on optimistic conflicts, and validate
envelopes/sources before invoking these primitives. Live queue/Lambda wiring remains later
work. Public ingress must reject both internal names, and fixture selectors must never
resolve a service identity.

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

The application dispatcher captures a cloned resolved identity/request and fixed server
instant, then constructs a scoped repository/unit of work for that invocation. The DynamoDB
adapter delegates state reads to `DynamoDbRepository` and composes public transaction builders
for writes; it does not use an unextended `DynamoDbCommandUnitOfWork`, whose idempotency
condition does not support logical expiry reclamation. Use corresponding scoped wrappers
around in-memory persistence. Never mutate a shared repository's scope while requests are
concurrent. Require keys of 1-200 ASCII letters/digits or `_ . : -`, without whitespace.

Strong reads treat `expiresAt <= floor(now/1000)` as absent; the transactional idempotency
put allows only an absent or expired record, preserving protection against live competing
requests while eventual TTL deletion lags. On a competing commit or ambiguous SDK failure,
perform at most four strong replay lookups with 0/10/25/50 ms pauses. A found record goes
through the core executor's existing parsed-input fingerprint check with a replay-only
repository/unit of work. Return its original response, including metadata, only on a match.
This also covers a winner committing between initial lookup and a stale decision. Never
retry the mutation itself; absent replay records leave the original conflict/unavailable
result intact. No private fingerprint implementation is copied into the consumer.

The same single-resource commit owns activity, projections, outbox, and idempotency. Do
not issue a second direct event publication or cross-resource write after returning success.

### Review and Asset Materialization

Each materialization event contains the complete bounded target snapshot, target ID, and
the next content resource version as `sourceVersion`. This includes the frozen submission
for review outcomes and tombstone information for removed assets. Do not publish only a
pointer that would require recovering an old revision from mutable content state.

The projector reads the target strongly, ignores older or equal-identical source versions, and uses
the target's own optimistic commit to apply a newer snapshot. On conflict, reload and compare
again. An approval arriving before the submission event still creates a complete approved
review; the late submission cannot restore pending state. Deletions materialize tombstones,
not physical row deletion that permits an older event to recreate an active attachment.
Equal-version differing snapshots are conflicts, not silent successful replays. Shared
handlers bound optimistic load/compare/upsert to three attempts and use internal scoped
commands; target corruption or immutable/outcome violations fail without a secondary write.

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

Phase 9 registers only `materializeReview`, `materializeAsset`, and review-request/decision
notification subscriptions from this table, through `src/domain/subscriptions.ts`. The
publication/reminder rows are now supplied by Phases 11/12. Handler validation
requires the exact configured source, envelope/schema version 1, bounded safe event/trace
IDs, target-matching resource IDs, and strict typed outcome payloads. Tenant envelopes are
rejected by this single-workspace consumer. Source checks supplement trusted transport/
ingress configuration; a matching source string alone is not authentication.

Reserved payload `delivery: { originalEventId, generation }` metadata supports the planned
recovery boundary, with strict keys and generation 1-3. Strip it before strict fact parsing
and business hashing, retaining the original event ID for delivery deduplication. Phase 13
still owns authorized creation of replays from durable stored envelopes. Materialized output
events retain incoming correlation and use the incoming transport event ID as causation.

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

Phase 7 implements one strict `commandReceipt` variant, derived from validated commit
metadata: resource type/ID, command, subject, positive safe resource version, and the server
command instant as `committedAt`. Each string is bounded to 200 characters (IDs/names use
the same safe ASCII components); the receipt contains no user body or unbounded collection.
The key is `OPS#commandReceipt` / `<resourceType>#<resourceId>#<version>`, with a create-only
condition in the same transaction. It provides a concrete auxiliary atomic-write contract
without prebuilding publication/notification protocols. Later phases add explicit typed
attempt/delivery variants and their access patterns, not arbitrary caller-supplied SDK actions.

The shared planner canonicalizes projection sorts through the exported physical key builder.
Same-key deletes plus a put become one put, equivalent puts/deletes coalesce, and conflicting
puts or other duplicate action keys fail before sending. The primary and idempotency
conditions are retained. The memory adapter stages under a per-store commit queue and
publishes state, activity, outbox, exact-key projections, receipts, and scoped idempotency
without yielding; failures leave every collection unchanged. SDK contract tests and the
live owned-table scenario cover the same moves and rollback rules.

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

Phase 2 contract decisions: `QueryRepository` is additive and separate from the command
repository. Queries default to 50 items with an integer maximum of 200. Activity is always
ascending; projection direction defaults to ascending. Compare complete physical sort keys
in UTF-8 byte order, using the existing mapper's optional `#itemId` suffix rule. Projection
ranges are `[sortFrom, sortBefore)` against those keys: equal bounds are empty, reversed
bounds are invalid. Query names must have a resource prefix and nonempty dot-separated
segments. Bound/continuation keys are at most 1,024 UTF-8 bytes and physical partitions at
most 2,048 bytes. Unknown query options, including raw database keys and filters, are rejected.
The ordering follows [DynamoDB Query](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html)
string-key semantics rather than locale collation.

The version-1 cursor carries a base64url continuation sort key plus a SHA-256 fingerprint
of query kind, physical partition, range, and direction. The whole envelope is canonical
base64url and at most 4 KiB. Page size is not part of scope, so callers may change it while
continuing; the cursor is not signed and confers no access. Invalid queries/cursors throw
the additive `query.invalid` runtime error (HTTP 400). Memory reads return detached records
and continue by key comparison even after boundary deletion. Paging is not a snapshot;
concurrent inserts or sort moves can change later pages. An absent cursor ends the read;
an empty page is valid. Legacy array methods retain their behavior. Application filters
need an outer, filter-bound cursor in the later query-handler phase, not unscoped filter
options in this low-level API.

Phase 3 implements both DynamoDB methods using the public key/item mappers and shared
async `prepareProjectionQuery`/`prepareActivityQuery` contexts exported by core. The shared
codec uses native Web Crypto without changing version-1 fingerprints. Each service read
makes at most one Query, with the normalized limit and configured consistency. Fixed
item-kind filters can yield empty pages; retain their exact `LastEvaluatedKey` sort key
and reconstruct the selected partition. Validate returned keys and monotonic progress;
malformed service pages fail as sanitized `runtime.internal` errors, not empty successes.

For a half-open projection range, query from the near bound in the requested direction
and trim/stop at the far bound in the adapter. This avoids pretending DynamoDB supports
two separate sort-key inequalities or an exclusive `BETWEEN` upper bound. Never refill
pages in an unbounded loop. Service byte limits and filters can shorten pages, including
an empty page with continuation; only cursor absence means exhaustion. A continuation
past the far bound is omitted because the requested range is exhausted. Consumer filter
budgets remain above this API. The live harness compares multi-page reads and explicit
transactional old-key deletion/sort/partition movement against memory.

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

### Phase 10 Domain Decisions

Schedule commands require current expected version, approval review/revision IDs, and (for
reschedule/cancel/due evaluation) the visible schedule generation. The server generates a
fresh schedule UUID and stores the revision with the UTC instant/IANA zone. Commands accept
explicit-offset millisecond timestamps, normalize to UTC, and validate future time and zone
identity; Temporal local-wall-time conversion/DST rejection remains Phase 12. A UTC input
with a non-UTC display zone is valid: offsets identify an instant, not a wall-time parser.
`publishNow` may immediately override a scheduled item, retaining the schedule only as
frozen intent provenance. Only the dedicated due worker may request a due publication.

`publication` is a required nullable content field. Once requested, its immutable intent
holds the publication ID, content ID, `requestedAt`, complete submitted snapshot, approval,
and optional original schedule. Operational state contains execution generation, phase,
attempt count, at most one claim/latest attempt, and eventual artifact metadata. No growing
attempt array lives in the aggregate. Archived published state must still match its frozen
snapshot, approval, and artifact; archive does not remove historical references.

Use three attempts per generation and four generations maximum (initial plus three editor
retries). A claim gets a caller-generated fresh attempt UUID, server-generated fencing UUID,
and exactly 90 seconds. Completion/failure requires the active publication/generation/
attempt/token and server time within the claim interval. Queued/running/failed/stalled
publication all retain the content `publishing` lock. The third expired lease stays stalled
until explicit retry or later reconciliation; it does not silently reset the attempt budget.

`storage.unavailable` and `execution.interrupted` failures release claims for another attempt
until the third failure; `artifact.mismatch` and `snapshot.invalid` terminate the cycle on
the first failure. The input is an allowlisted code, never an arbitrary error string. Editor
retry requires failure in the current generation or an expired active claim, cannot displace
an unexpired claim, and preserves intent/key/request time. Already-queued new generations
cannot retry again using an older generation's failure. Terminal corruption is never
automatically repaired/overwritten; explicit retry preserves the same bytes after operator
intervention rather than authorizing a new draft or different artifact.

The dispatcher post-validates successful `claimPublication` responses with a strong current
state read and fresh server clock. This includes core idempotent/concurrent-response replay:
a once-successful response is now a conflict if its claim expired, completed, was replaced,
or has not started under a regressed clock. This app-only check avoids modifying core or
returning an old fencing grant indefinitely. Same-payload retries within a live claim retain
the original response; a genuinely new attempt must use a new UUID/key. Different payloads
at the same key still fail the ordinary fingerprint check.

Claim/outcome/lease-expiry facts carry a redacted attempt view, without fencing tokens.
The app planner derives at most two typed attempt operation records per command plus
all/per-content history projections, sharing the primary state/activity/outbox/idempotency/
receipt transaction. Immutable keys are `OPS#publicationAttempt` /
`<contentId>#<publicationId>#<attemptId>#<stage>`; generation is metadata, not part of the
uniqueness key, so old attempt UUIDs cannot be reused across generations. Claim replacement
or retry closes an expired predecessor in the same commit. The query projections are
`contentItem.publicationAttempts` and `contentItem.publicationAttempts.<contentId>`, with
immutable start-time/attempt sort keys and current stage data. Both adapters stage all
records atomically; auxiliary collision rolls everything back. The 60-action budget and
physical-key deduplication still cover the composed transaction.

The stage facts are `publicationClaimed`, `publicationAttemptSucceeded`,
`publicationAttemptFailed`, and `publicationLeaseExpired`. Requested/retried facts carry
the complete frozen intent; published/terminal-failure facts carry bounded outcome metadata.
All are version 1 and use the existing envelope/correlation/causation path. Internal publisher
and due-worker roles are not exposed as UI commands or fixture choices. Phase 11 now registers
`publishContent` with actual object write/verification. Phase 10
completion accepts trusted internal metadata (fixed key, SHA-256 shape, at most 80 KiB) but
does not claim object existence, serialization/digest equality, or cloud execution.

### Phase 11 Execution Decisions

The v1 artifact is UTF-8 JSON with explicit insertion order and one trailing LF. Fields are
`schemaVersion`, `publicationId`, `contentId`, `requestedAt`, `approval`, `schedule`, and
`content`; nested content fields are revision, author, title, body, submission instant, and
attachments sorted lexically by asset UUID. All instants serialize as UTC milliseconds.
Preserve body Unicode/whitespace; exclude operational generations, claims, and completion
times. SHA-256 and size cover the exact bounded bytes. This is a versioned application
format, not a general RFC canonical JSON implementation.

Memory/S3 stores conditionally create and verify the exact bytes. S3 additionally checks
JSON type, length, digest, and content/publication metadata with bounded readback. Matching
existing objects recover; mismatches terminate without overwrite. The publisher checks the
frozen event against authoritative intent before claiming, uses a fresh attempt UUID/key,
and rereads/rechecks the fence before object work and completion. A live competitor throws;
obsolete generations and matching completed work are the only successful no-op outcomes.
Failing/releasing a lease is conditional on still owning it; a stale worker cannot fail its
successor. A hard crash leaves the lease intact, including the object/domain split.

Exact-operation fault callbacks are construction-time test dependencies only. Injected
process interruptions bypass normal failure recording to model lease recovery. There is no
HTTP fault endpoint, environment failure switch, direct notification provider, or alternate
publication authority. Published/terminal facts add `outcomeAt` from the attempt finish so
local outcome notification identity/order remains stable across replay.

The memory runtime registers the real publisher. A separate `publication.zip` exports its
SQS entrypoint using the public framework adapter/marker store. Validate the entire batch
(1-10 records, bounded bytes, queue ARN, exact source/type and strict app facts) before marker
lookup. Mark only after domain completion; marker gaps/expiry recover through business state.
The Lambda object store accepts only the owned publisher name/lab ID and fixed worker
endpoint, with explicit dummy credentials and final destination guards. The four-function
spine lab is unchanged; application deployment/route grants remain Phase 20/21. Phase 11's
live consumer artifact proof calls the shared service on real DynamoDB/S3, not a substitute
for deployed SQS delivery. The separate spine still verifies the actual managed transport.

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

### Phase 8 Implementation Decisions

`src/shared/assets.ts` defines strict pending/ready/removed/expired slots with generated
content/asset/key identity, uploader, claimed filename/type/size, one-hour deadline, verified
size/SHA-256/time, retirement time, and content `sourceVersion`. At most 10 slots are active;
at most 32 slots including retained tombstones exist on one aggregate. This explicit
development bound prevents unbounded root history without silently discarding references.
Registration at capacity is rejected. All existing serialized state/snapshot/event bounds
remain enforced. Ready review references omit mutable upload lifecycle metadata.

Registration/removal/expiry change the revision; readiness alone preserves it because
submission cannot precede readiness. Every changed slot emits a full version-1 snapshot.
Only dedicated `upload_verifier`/`uploadVerifier` and `asset_janitor`/`assetJanitor` identities
can complete/expire, respectively; fixtures cannot impersonate them by adding roles.
The service treats an already-ready matching retry as a read-only success; raw completion
requires a pending slot (or replay of the original scoped command). Ordinary ingress must
not expose internal names. These development service identities are not production auth.

The transport-independent service admits at most two uploads per instance, applies a
30-second stream deadline/cancellation and byte ceiling, rechecks authority after streaming
and object creation, and bounds optimistic completion to three attempts. It refreshes
expected version only after reloading/rechecking the current slot; it does not retry a stale
editorial decision. Interrupted I/O is sanitized and never marks a slot ready. HTTP routing
and authenticated download behavior remain Phase 14, not a Phase 8 API claim.

Both object-store adapters derive keys from validated UUIDs, detect leading PNG/JPEG/PDF
signatures, calculate SHA-256, and verify bounded readback. Signature detection is not full
format decoding, sanitization, or antivirus scanning. The memory adapter copies byte arrays,
defaults to 128 objects/128 MiB, and allows bounded overrides up to 256 objects/256 MiB.
The S3 factory rejects inherited AWS credentials/configuration and nonlocal endpoints or
foreign bucket/region before sending. It uses explicit test credentials, the existing
final-destination transport guard, finite SDK retries/timeouts, `If-None-Match: *`, and up to
three conditional-conflict attempts, followed by type/size/metadata/digest readback.
See [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).
The [PNG signature](https://www.w3.org/TR/png-3/#5PNG-file-signature) is checked exactly;
JPEG uses SOI/marker bytes and PDF uses a leading supported version header.

Neither adapter exposes overwrite/deletion. Verified removed slots retain verification
metadata and bytes conservatively until reset, protecting historical approved references
without requiring an eventually consistent asset query. Phase 12 may clean only sufficiently
old, authoritatively retired unverified orphan objects; it must not delete verified historical
references or forget their tombstones while bytes remain. Phase 12 supplies explicit maintenance
ticks; consumer Scheduler deployment remains Phase 20.

The asset factory supplies internal `createSnapshot`/`applySnapshot` commands under the
dedicated asset-projector identity, preserving immutable identity/verification and terminal
retirement metadata. Complete tombstones may arrive before pending/ready facts; stale or
regressing facts cannot revive them. Projections include stable `asset.list` and
`asset.content.<contentId>` rows, including retired statuses. Phase 9 supplies envelope
validation, out-of-order ignore/reload loops, subscriptions, and shared materializer handlers;
their live Lambda/queue transport composition remains later work.

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

### Phase 12 Implementation Decisions

`createContentJobs` implements `duePublication`, `dueReview`, `expireUploads`, and
`cleanupOrphans`; the memory runtime exposes explicit `app.jobs.tick(name)`, never timers.
Each tick admits at most 50 one-candidate query pages within a 20-second monotonic budget.
Finite SDK requests/checkpoint release may finish beyond the admission deadline. Smaller
test/operator budgets may not exceed these bounds. Failed candidates advance progress and
are revisited on the next pass; unattempted time-exhausted candidates retain their cursor.
Empty service continuation pages consume the same budget. Strong authority checks reject
stale schedule/review/revision candidates before issuing a fenced internal command.

Application-owned `JOB#<name>` / `CHECKPOINT` rows (`APP_JOB`) retain a revision, UUID token,
30-second lease, and `{ passCutoff, cursor }`. There are four records, no growing history or
TTL. Acquisition strongly reads then conditionally creates/replaces; every save/release
checks token, revision, and active lease interval. A lost acquisition response grants no
usable lease; wait for expiry. Crashes resume the last saved cursor; stale owners cannot
overwrite a successor. The cutoff and query scope remain fixed across clock changes and
deleted boundary keys. Memory provides the same conditional semantics without SDK calls.

The current review gains required nullable `lastReminderDay`. Internal `recordReviewReminder`
requires due-worker identity, expected version, current review/revision, pending status, and
server due time. Only a strictly later UTC day can advance the marker; regressed clocks
cannot resend an older day. State, activity, projections, receipt, idempotency and full
`reviewReminderRecorded` fact commit together. Revision/submitted snapshot do not change.
The fact contains the full current review plus `remindedAt`; materialization preserves
monotonic reminder history, and `review-reminder.v1` notifies the assigned editor using the
original business instant through the existing replay-safe sink. This private development
schema evolves in place; reset older ephemeral datasets rather than treating them as migrated.

Content-owned `expiringUploads` and `orphanAssets` projections identify candidates, not
deletion authority. Cleanup requires a retired, never-verified slot, no current frozen
review/publication reference, and both retirement/object timestamps at least 24 hours old.
Read content strongly before inspection and again before deletion. The age bound uses
`min(passCutoff, now) - 24 hours`, so clock rollback never relaxes retention. Missing/corrupt
parents, archived content, verified historical assets and publication JSON are not deleted.
Memory compares its observation; S3 re-heads exact generated asset keys, requires an
unversioned owned bucket, and uses an ETag-conditioned delete. Changed/young/missing objects
are skipped; errors fail closed. Keep all tombstones after deletion, including never-verified
ones: late uploads cannot revive a slot, and future sweeps may remove late-created orphans
only after they age. Slot-capacity reclamation/archival cleanup is deliberately not added.
See the primary [S3 conditional delete API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html).

`src/shared/time.ts` uses pinned `@js-temporal/polyfill@0.5.1` with no global mutation.
Accept a strict local ISO date/time and IANA zone, reject overflow and gap/fold disambiguation,
then serialize a UTC millisecond instant. Review/schedule inputs share explicit-offset ISO
validation/UTC normalization; server decisions validate future time. See the
[Temporal time-zone conversion contract](https://tc39.es/proposal-temporal/docs/zoneddatetime.html).

`jobs.zip` exports `scheduled`, composing actual jobs/checkpoints/stores through the public
Scheduler target adapter. Local S3 permits the exact owned publisher or jobs Lambda context
on the fixed worker endpoint. This phase does not provision consumer schedules/queues or
modify the four-function feasibility spine. Live evidence uses shared jobs directly on real
DynamoDB/S3 with an injected clock, while the independent spine still proves automatic
Scheduler/managed transport. Full consumer deployment/grants remain Phase 20/21.

### Notification Sink

Subscribe to review request/decision, publication success/failure, and review-reminder
events. A delivery ID is derived from the original source event ID, recipient, and template
version. In memory use an atomic map insertion; in DynamoDB use a conditional transaction
for the delivery record and its operation/query records.

Because the durable local sink is the destination, duplicate executions can converge on one
visible delivery without calling any external provider. The worker returns successfully
only after that record is committed. A later email/Slack adapter would need a new delivery
contract; do not claim these guarantees apply to arbitrary external effects.

Phase 9 implements three version-1 templates: review request, approval, and changes requested.
Recipients come from the validated immutable snapshot (assigned editor for requests, author
for decisions), never from an address supplied by the transport. The delivery ID hashes
`[originalEventId, recipientId, template]`; template names include `.v1`. A canonical parsed
fact hash protects against different content at that same identity. Notifications contain
bounded plain text and references, not raw body/asset bytes or active HTML. They are not
an external-provider abstraction with an implied exactly-once guarantee.

The sink commits four create-only rows: `NOTIFICATION#<deliveryId>/DELIVERY`, a typed
`OPS#notificationDelivery/<deliveryId>` operation, and public projection-builder rows for
`contentItem.notifications` and `contentItem.notifications.<fixtureId>`. Query order is the
immutable fact occurrence time plus delivery ID; decision/request times come from their
snapshot, not a replay transport's later timestamp. Query limits are 50 default/100 maximum
with the public paging contract. A duplicate/ambiguous transaction rereads strongly and
returns the first stored record, preserving its transport/correlation/causation/time metadata.
Different business content conflicts; no destination/operation/query row has TTL.

Memory uses the same query projections in the shared app store and synchronous staged map
insertion; command commits and sink inserts cannot lose one another's projection rows.
It retains up to 1,000 deliveries by default (bounded override to 10,000), never evicting
business deduplication at capacity. New delivery attempts then fail retryably until reset
or a later explicit retention feature. DynamoDB uses one typed four-action transaction;
there is no arbitrary auxiliary-write DSL or fake resource mutation to represent delivery.

### Memory Pump and Runtime

`createMemoryRuntime` composes actual domain/persistence/upload/handler/sink components;
construction starts no timer/server/client. The explicit pump scans committed outbox facts,
selects only implemented subscribers, and invokes the same handlers used by later AWS
transport adapters. It is not an emulation of buses, queues, Lambda, or distributed leases.
Each pass scans/attempts at most 50 events/handlers by default (explicit limit 1-100), and
concurrent drains serialize. Materializer output events are scanned but have no subscribers.

Each job attempts at most three times, with injected-clock +1/+2-second backoff cutoffs.
Terminal jobs retain the source privately and expose sanitized diagnostic summaries. The
job bound is 200 pending/terminal entries; the success-marker cache is 1,000 entries with
seven-day logical expiry and bounded oldest-entry eviction (both configurable up to 10,000).
Marker loss/expiry is safe because resource source versions and permanent sink IDs are the
business idempotency boundary. Capacity backpressures complete event fan-out without moving
the outbox cursor; failed records are not silently evicted. Corrupt/oversized outbox entries
or same-ID transport rewrites fail the drain explicitly rather than being treated as success.

`drainUntilIdle` is bounded to 20 passes by default, 100 maximum; idle means no immediately
due work, not that delayed/failed work disappeared. `createFixtureClock` supplies monotonic
explicit clock advancement for tests; no drain sleeps or advances the clock implicitly.
Use a fresh runtime for a reset/reseed, since outbox cursors and permanent business records
belong to the same volatile dataset. Phase 13 adds durable failure collection/replay within
that dataset. Automatic HTTP pumping,
and deployed consumer transports remain later phases.

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

### Phase 13 Implementation Decisions

`createFailureService` implements collection, publication reconciliation, inspection, replay
authorization, and successful replay resolution. It accepts only validated source-scoped
facts subscribed by one of the four implemented workers. Deterministic failure IDs hash
consumer plus original event ID, not a delivery receive/message ID. Retain one canonical
validated original envelope/fingerprint, at most four collection stages, and three bounded
recovery requests. The canonical form preserves every original envelope/business field;
JSON property insertion order is normalized through the existing strict schemas.

Application-owned `FAILURE#<id>` / `DELIVERY` rows (`APP_FAILURE`) are permanent for the
development dataset, version-conditioned, and bounded to 128 KiB. Collection stages retain
transport ID/generation, first collection time, pending/final reconciliation and result.
Recovery requests retain fresh UUID, time, editor and request UUID. The public
`contentItem.failures` projection exposes only bounded redacted summaries/history and trace
identity, not original private bodies. Memory defaults to 1,000 records with a 10,000 maximum
override and never evicts identities to make room; capacity fails safely. DynamoDB has the
same record/history bounds and dataset-lifetime retention, without a global count scan.

First persist a pending collection, then reconcile, then mark that collection complete.
Repeats must continue pending work rather than treating record existence as acknowledgement.
Live matching publication claims defer without a collector marker. Expired matching claims
close as expired in the same content/history transaction that sets `phase: "stalled"` and
its required nullable `deliveryFailure` marker. An exhausted queued delivery can stall with
zero attempts; do not fabricate worker execution. The resulting publication-failure fact
uses the reconciliation instant and sanitized `execution.interrupted` code, not a raw SDK
error. Already failed/succeeded, replaced generations and nonmatching newer claims are
classified without overwriting current authority. A retry after the domain commit but before
collection completion recognizes the durable marker and finishes the second step.

Editor `retryPublication` now admits explicit stalled delivery, clears its marker and
advances the existing maximum-four generation protocol with the same frozen intent. Generic
CLI replay rejects publication; it cannot enqueue the old generation as a substitute retry.
Its three-cycle budget is authoritative on content, not reset by new failure record IDs.

Manual envelope recovery allows only review/asset materializers and the notification sink.
Load the original from its validated stored record, assign fresh transport UUID/time, retain
original actor/correlation/business payload, and set causation to the original event ID.
Payload `delivery` adds `{ originalEventId, generation, consumer, failureId }`. Consumer and
failure ID must appear together; existing two-field metadata remains parse-compatible only
for older trusted fixtures, not accepted as a new durable recovery. Authorization reconstructs
the exact expected replay from the stored request, rejecting altered facts, IDs, consumers,
and unrecorded generations. Workers ignore unrelated targeted fan-out copies without effects.

Commit recovery state/view and the create-only public outbox item in one DynamoDB transaction
or non-yielding memory commit. No direct bus/queue publication occurs. Conditional conflicts
or ambiguous responses get at most three strong reread/update attempts; a stored request UUID
or already queued cycle does not burn another cycle. The next manual cycle requires collected
failure of the previous delivery. Success marks the corresponding recovery resolved before
the worker marker; old collection cannot downgrade a later successful generation. Permanent
source-version/delivery/publication checks survive physical marker deletion/TTL expiry.

Memory terminal jobs call the same collector, release capacity only after collection, and
use a separate bounded collection cache rather than falsely marking failed workers successful.
Deferred/failed collection retains the source job with a one-second injected-clock retry.
Foreign/malformed envelopes, unsupported consumers and unrecorded replay traffic are rejected
without acknowledgement. Investigate these in the retained DLQ; there is no unbounded
collector-DLQ chain or replay path for arbitrary content. Periodic job ticks resume through
their checkpoints/next invocation rather than entering manual fact replay; service-level
Scheduler failed-target wiring remains part of the Phase 20/21 deployment boundary.

`recovery.zip` exports actual worker/collector entrypoints backed by public SQS adapters.
Snapshot and validate the complete bounded batch (origin ARN, source/type, schema and
subscription) before any marker lookup; authorize durable replays/collected originals even
on cached delivery. The publication entrypoint shares this transport validation. Consumer
wrappers explicitly configure seven-day markers, avoiding the framework's fourteen-day
default without changing public packages. No consumer mappings/queues are provisioned yet.

`jobs:inspect` / `jobs:replay` are local-only CLI commands. Require an explicit editor fixture,
strict arguments and an owned ready lab manifest; verify the table ownership tag before
operation. Inspection pages 50/100 maximum; replay accepts only a failure ID and optional
stable request UUID. No payload, queue, consumer, endpoint or real-AWS override is accepted.
CLI output is redacted and errors omit raw SDK/child output. Memory exposes equivalent
programmatic methods; it cannot inspect another process's volatile dataset. These fixtures
are not production authentication. The private publication schema evolves in place; reset
older ephemeral datasets rather than implying a migration guarantee.

Fault callbacks at exact record/reconciliation/replay-commit boundaries are construction-time
test dependencies only. The live gate exercises shared adapters and owned CLI on real local
DynamoDB/S3, including a physical worker-marker deletion, deferred/expired publication
collection and editor retry to one artifact. It does not substitute these direct calls for
the separate actual spine/redrive proof or claim deployed consumer DLQ mappings.

## HTTP and Angular Design

### Ingress and Identity

Use a small Node HTTP router and existing API success/error envelope shape. Application
commands call public `executeCommand` through the scoped dispatch service; application
queries and uploads use explicit handlers. Do not copy the framework executor or expose
its entire internal registry as an unrestricted HTTP router.

Resolve `x-content-ops-fixture` to a fixed server-side directory containing two authors and
two editors (`author_1`, `author_2`, `editor_1`, `editor_2`). Ignore caller-supplied subject/roles/claims headers. Internal service identities
are constructed in process and cannot be selected from an HTTP header. Reject non-local
configuration and reject cross-origin mutation requests; development identity is still not
secure authentication against another local user or process.

Bind API port 4327 and Vite port 4326 to `127.0.0.1`, with a Vite `/api` proxy. Fail clearly
if configured ports are occupied; support an explicit port override in browser-test setup.
Use same-origin routes rather than broad CORS. Validate `Host`/`Origin`, bound JSON requests
to 256 KiB, and keep upload limits separate. Never return stack traces, raw AWS failures,
credentials, bucket configuration, or uploaded bytes in diagnostic error bodies.

### Routes and Client

| Route                                                                  | Purpose                                                                     |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /api/health`, `GET /api/manifest`, `GET /api/fixtures`            | Readiness, public metadata, and fixed development identities.               |
| `POST /api/resources/contentItem/commands/create`                      | Create through normal command dispatch.                                     |
| `POST /api/resources/contentItem/:id/commands/:command`                | Allowlisted user commands only; idempotency key and strict input.           |
| `GET /api/content`, `/api/reviews`, `/api/calendar`, `/api/operations` | Typed, filtered, paginated application queries.                             |
| `GET /api/resources/:type/:id`, `/api/resources/:type/:id/activity`    | Allowlisted resource reads and paginated activity.                          |
| `PUT /api/uploads/:contentId/:assetId`                                 | Verified, bounded attachment upload.                                        |
| `GET /api/assets/:assetId/download`, `/api/content/:id/publication`    | Authorized downloads and committed artifact previews.                       |
| `POST /api/development/seed`                                           | Editor-only deterministic seed through normal commands and upload services. |

### Phase 14 Implementation Decisions

`src/http/server.ts` exposes only the shared user-command map, never the internal registry.
All four fixtures read the shared workspace; mutation rules remain in the domain, and
operations/seed require editors. Resource and projection DTOs validate stored schemas,
allowlist fields, and remove object keys/fencing tokens; errors retain only safe conflict
details. Activity exposes bounded public metadata, not arbitrary stored diagnostic data.

Application query schemas/types live in browser-safe `src/shared/api.ts`. List queries bind
opaque cursors to fixture, normalized filters, selected query partition/range, and a fixed
overdue cutoff. Page size can change. Each request charges requested service limits toward
a 200-candidate budget, since empty/short service pages can consume their full limit; it
returns continuations even without matches. Page size is 1-100 (default 50), cursor max
4 KiB, calendar range positive and at most 42 days. Archived content retains only an explicit
archived-status projection, not active/due/maintenance membership. Operations are editor-only
typed attempts/notification/failure summaries; callers cannot choose storage partitions.

Downloads use an asset row only as a parent locator, or an optional `contentId` query locator
before materialization. A strong content slot must grant a verified ready/removed reference;
the object store verifies bytes and authority is reread before serving them. Retained removed
references intentionally remain readable. Preview requires succeeded, published/archived
authority plus matching stored artifact bytes/digest, never object existence alone.

`dev:api` explicitly selects memory; `dev:api:local` selects guarded LocalStack. Memory runs
serialized bounded worker drains every second and due jobs once per minute. LocalStack checks
the ready ownership manifest, table/bucket tags, private access block, and disabled versioning;
it deliberately has no host consumer pump and reports `external-workers`. Phase 20 still owns
consumer queue/Lambda/Scheduler deployment. Seed uses six deterministic content IDs and real
commands/uploads, preserves existing IDs/edits, and uses server-relative due times and normal
revision/review IDs. In LocalStack it creates intents without simulating missing workers.

Neither import nor runtime construction starts a server/timer or resolves credentials. Only
explicit startup creates clients or managed work. Shutdown aborts pending bodies, stops timers,
waits for work/response completion, and closes clients. Bounds include 16 KiB headers, 8 KiB
targets, 256 KiB JSON, 10 MiB uploads, 30-second bodies, 64 connections, and 32 admitted requests.
The CLI fails on occupied ports and rejects non-loopback/non-local configuration. The
[consumer API guide](../../../apps/content-operations/API.md) is the current route/run contract.

### Angular Client

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

Phase 4 implements the structural metadata contract in `@jawstack/angular` without runtime
core imports. Full definitions remain assignable, not automatically sanitized: new browser
modules must import only shared schemas and UI metadata, not a server definition and then
cast it. Source tests and every library build bundle a presentation-only fixture with a
dependency-graph guard; the latter checks the compiled public entrypoint. Legacy demo/
template imports stay in place as compatibility regressions, not a claim their own module
graphs are already migrated.

`JawStackApiError` takes a message plus `{ code, status, details?, correlationId? }`; its
`status` is the actual HTTP response status and `code` accepts application-defined strings.
The default client reads `error.code/message/details` and `meta.correlationId`. Missing or
invalid HTTP error fields use `http.error`; malformed successful envelopes use
`api.invalid_response`. Invalid JSON is classified without exposing raw response text;
network, abort, and body-stream failures propagate unchanged. Existing success payloads,
request serialization, and ordinary `Error` message rendering remain compatible. Generic
components keep their existing display behavior; custom application views can branch on
the structured client error for explicit permission/conflict handling.

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

### Phase 15 Workbench Decisions

The implemented browser entrypoint is `src/web/main.ts`; Vite compiles Angular with strict
templates and an explicit emit-enabled browser tsconfig. The server/test tsconfig remains
no-emit. Only `@jawstack/angular` is aliased, not the core runtime or a Node HTTP shim. The
build rejects forbidden package and resolved-path imports in resolution/module loading and
the final graph, requires actual workbench/editor/shared metadata, and writes
`dist/web/browser-boundary.json`. The client/auth injection tokens resolve the same fixture
workspace. Client content result types represent redacted HTTP DTOs, not raw storage state.

`/content` implements list/board with URL title/status/author/view/limit/cursor, bounded
load-more, empty continued pages, and loaded counts rather than totals. Returning from a
detail preserves the query; view changes preserve already loaded rows. Active filters are
validated before requests; identity changes reset fixture-bound continuations. Requests
use abort signals and sequence fencing so stale responses cannot replace another view.

`DraftEditor` owns reactive form/dirty/pending/conflict/intent state, separate from routing.
Create/save validate shared inputs and preserve body bytes. An unchanged actor/target/input
intent retains its idempotency key on ambiguous retries. A 409 does not adopt a new version
or overwrite text; explicit comparison fetches a separate server value, and the user chooses
server adoption or local retention on the displayed base. New concurrent edits can conflict
again. Committed saves are recognized even if their follow-up strong read fails. Navigation,
refresh, and fixture switching protect dirty forms; pending saves block leaving, and native
unload warnings are enabled. The current phase treats other lifecycle states as read-only;
review submission, snapshots/decisions, and activity follow in Phase 16.

The shell uses one functional Content destination, a persisted fixed fixture selector,
landmark focus on route changes, labeled controls, native tooltips, and selected standalone
icons from [Lucide Angular](https://lucide.dev/guide/angular). No illustration substitutes
for operational content. Playwright has separate seeded memory/Vite processes, refuses
existing servers, owns teardown, and runs desktop/mobile screenshots and actual commands.
It remains opt-in rather than joining unit discovery; a later phase owns dedicated CI jobs.
The [workbench guide](../../../apps/content-operations/WORKBENCH.md) is the current run contract.

### Phase 16 Review Decisions

Review routes are `/reviews` and `/reviews/:id`. The queue supports URL status, assignment,
overdue, content-history, limit, and cursor filters. `status=all` is a browser alias for no API
status restriction. The server's new optional content filter uses existing known review
partitions and the same conservative 200-candidate budget; it adds no storage index or
caller-selected partition. Its content ID joins the normalized cursor scope. History can
return an empty continued page and must not be mistaken for complete results.

`ReviewSession` loads the materialized review plus strong content authority. A link may
carry a validated content locator to recover the exact matching authoritative snapshot while
the row is missing. For the current review, newer authoritative data wins over an older
materialization, with an explicit pending/synchronizing state. Unmatched missing history is
unavailable, never manufactured. Old materialized snapshots remain inspectable after new
revisions. The HTTP DTO reuses shared field validators but excludes private object references;
the raw domain schemas and cross-reference checks still govern all server writes.

Editor decisions dispatch only to content, carrying its loaded version, review UUID, and
submitted revision. That authority is pinned until explicit refresh, not silently advanced
by read-model polling. Any editor may decide a current review; assignment is routing, not
exclusive authorization. Required notes, duplicate-submit exclusion, stable intent keys,
structured stale/permission errors, and unsaved-note guards apply. Historical reviews cannot
approve another revision. Unrecorded notes stay visible/copyable and explicitly discardable
after a refresh makes the form ineligible. Pending/approved content can explicitly reopen
through its existing domain command. Body editing and submission are separate saved intents.

Visible pending rows poll every two seconds, back off to ten after a minute, abort/pause
while hidden, and stop on settlement or destruction. The serialized poll never rereads or
adopts a new content decision version. Primary activity is a separate five-record paged
view with retained review links; it does not claim all history was loaded. Route, success,
and validation focus are explicit. The review form uses a real reactive form group, ensuring
native submission invokes the decision command rather than reloading the document.
The fixture picker also uses an Angular form control so persisted identity is written after
its options register, and rejected dirty-work switches restore the displayed active fixture.
Caller abort signals combine with the existing 30-second client deadline for bounded polling.

Detail/review routes are lazy-loaded to keep production chunks bounded. Development explicitly
prebundles the already-pinned Temporal dependency to avoid an optimizer reload on first lazy
navigation. The module-graph gate requires actual review/activity modules and still forbids
server/core runtime/AWS/CDK/shim imports. No framework API, package version, or dependency changed.

### Phase 17 Attachment and Preview Decisions

Browser-safe media DTOs reuse field validators but omit storage keys. Attachment rows come
from the loaded strong content authority, not the eventual asset model. Native file inputs
validate safe filenames, exact supported types, nonzero size, and 10 MiB before registration.
The existing server still validates ownership, signatures, deadlines, and verified bytes.
XHR provides real bounded binary-transfer progress/cancellation; 100% is labeled verifying,
not ready. A fresh strong content read must confirm ready before a thumbnail appears.

`AttachmentSession` retains its File and registration intent/key after ambiguous errors;
retries target the same slot. Pending slots support matching-file reselection after reload.
Explicit discard clears the browser selection, not domain membership; explicit removal uses
the loaded content version with a stable ambiguous-retry key. A conflict preserves the File,
text, and base version and requires refresh. Dirty text excludes attachment mutations; pending
mutations exclude other commands/navigation/identity changes. Submission fields survive media
updates. Native unload/discard warnings cover selected files, without claiming offline storage.

Private attachment reads carry the fixture header and parent locator. The client checks
actual returned media type, byte size, and SHA-256 before creating image/download Blob URLs.
Images are real verified PNG/JPEG bytes; PDF is download-only. Requests/URLs have teardown
and replacement cleanup. The domain's ready/removed historical reference policy stays intact;
published membership remains read-only. Safe display text uses interpolation, never HTML.

Publish-now carries the loaded content version and exact approval review/revision; ambiguous
retries keep the intent key. Strong-authority polling advances only locked publication
outcomes, not an editable decision base. It uses the existing visible-only serialization,
2-second/10-second backoff, hidden abort/pause, and settled/destroy cleanup. Failed/stalled
states stay locked; the operations/retry UI remains Phase 19. The existing preview endpoint
verifies actual stored bytes and committed metadata before returning its redacted view.
The UI compares its publication identity/digest/size to loaded committed authority, renders
plain frozen content plus guarded attachment downloads, and exports redacted JSON. Stored
artifact digest/size are explicitly labeled: they do not describe the reformatted redacted
export. No raw object keys, uncommitted preview, executable document embed, or new public
framework/API route/dependency is required.

### Phase 18 Scheduling and Calendar Decisions

`ScheduleSession` owns an explicit local datetime/IANA-zone reactive form, dirty state,
validation, a pinned content base, and stable ambiguous-retry keys. Existing Temporal conversion
rejects gaps/folds; reverse conversion preserves stored milliseconds and the schedule's zone.
The form shows the resulting UTC instant. Native datetime controls shorten fractional seconds
(for example `.100` to `.1`); the local converter accepts one-to-three digits and always emits
the unchanged three-digit UTC contract. The server retains its independent future-time check.
Schedule/reschedule carry the approved review/revision; reschedule/cancel carry the exact loaded
generation and all mutations use the content version, never a calendar projection version.
Cancel returns to approved; owning authors/editors may reopen scheduled content through the
existing command, invalidating schedule/review/approval. No scheduling API/domain change is needed.

Dirty proposals receive navigation/fixture/refresh/unload guards. Pending scheduling includes
the follow-up strong read and excludes other mutations. Confirmed commands are acknowledged
even if that read fails; unchanged retries retain the exact original command key/input. A 409
retains time/zone/base until explicit refresh. Scheduled detail polls visible strong authority
for the server's actual due/publishing outcome, not to silently adopt a remote reschedule or
cancel/reopen base. Locked publication can advance the displayed content while retaining an
unapplied local proposal as read-only/copyable/discardable. No browser timer publishes content;
the existing runtime due job and publisher remain the only automatic execution path.

The lazy `/calendar` route accepts validated URL date, IANA zone, month/agenda mode, bounded
limit and scoped cursor. Default date is today in UTC. Its query range is the first valid instant
of the selected local month through the first instant of the next month, not 42 local days:
a six-week grid spanning a fall-back can exceed the API's hard 42x24-hour bound. Calendar bounds
use Temporal's start-of-day behavior for midnight gaps/skipped dates, distinct from rejecting
ambiguous user-entered publication times. The 42-cell Monday-first grid keeps outside-month
dates muted/unqueried. Day slots have stable dimensions; long/multiple entries scroll within
their day, and mobile count buttons expose the ordinary month agenda without drag/drop.

Both modes use the same loaded UTC rows, regrouped by the selected display zone; agenda labels
retain offset/zone abbreviations. Loaded counts never imply completeness. Explicit load-more,
empty continuation, request abort/sequence fencing, fixture cursor reset, error/retry, and URL
return navigation follow existing consumer patterns. Detail return context includes the source
fixture solely to discard a continuation after an off-calendar identity change; it grants no
authority. A view-only toggle preserves loaded pages.
Calendar reads remain explicit-refresh snapshots of scheduled membership, not publication
history. Strong content detail gates all mutations. Agenda stretched links are contained to
their own positioned row, with arbitrary long titles wrapping rather than covering controls.

Browser scheduling verification injects a clock into a per-test loopback memory API, routes
actual browser HTTP traffic to it, and lets only the Node test host advance the clock and run
the existing due-job/publisher protocols. No production clock endpoint, shorter production
job interval, direct publish-now substitute, or fake completion is introduced. The ordinary
seeded browser API remains independently owned. No dependencies or public framework contract
change is needed; the browser graph now requires the real calendar and scheduling modules.

### Phase 19 Operations and Recovery Decisions

The lazy `/operations` screen uses the existing editor-only query endpoint for paged attempts,
local notification deliveries, and redacted failed-delivery summaries. Its URL preserves view,
content/status/recipient filters and bounded paging; view/status mismatches are invalid UI
queries. The typed client checks projection, item identity, filter scope and view-specific DTO
before rendering. Pure operation field schemas now live in `shared/operation-views.ts`, with
compatible server reexports. Server-only notification hashing/cross-field checks, failure-envelope
validation, and operation-transition validation remain in their original owning modules.

Native disclosures show actual trace IDs, times, failure codes and bounded collection/recovery
history, not raw source payloads or private object/fencing references. Notification status remains
the implemented local sink's `succeeded` contract; failures/pending replay belong to failed-delivery
history, not fabricated notification rows. Links resolve content/review authority and snapshots.
Attempt timestamps can tie: their stable ID tiebreaker is not a generation-order guarantee.

A selected content UUID loads strong publication state; the reusable recovery widget also appears
on content detail. The pure `publicationRecovery` policy is shared with the existing domain retry
gates, preserving their semantics. Displayed eligibility remains advisory because browser time
and snapshots can be stale. The command independently enforces resolved editor role, content
version, publication ID/generation, live lease exclusion, recoverable work and the four-generation
budget. Three attempts per generation and at most three manual advances are displayed separately.
Expired running claims display stalled plus the recorded phase/deadline, not certain failure.

Retry intents use the existing idempotent public command. Ambiguous responses retain exact
keys/inputs; stale conflicts pin the base until explicit refresh. Acknowledged retries survive
follow-up read failure and poll for real authority. Read/mutation pending state blocks other
controls, fixture switches, route/query navigation and native unload. The operations route reruns
deactivation guards on query changes, preventing browser history from discarding an active retry.

`RecoverySession` owns bounded strong reads and the existing visibility-aware serialized poll.
It pauses/aborts while hidden, backs off from two to ten seconds after a minute, stops on settled/
expired states, and destroys timers/listeners/requests on navigation. Publication detail retains
its separate scheduled-state observation, handing publication phases to this widget rather than
running duplicate publication loops. The initial ledger page follows pending rows/selected pending
publication using the same polling rules. Explicit load-more stops ledger following and labels a
snapshot, preserving loaded pages and avoiding an unbounded multi-page background scan. Strong
selected authority remains independent; settled deliveries can be explicitly refreshed later.

Other-consumer replay remains CLI-only through the existing bounded failure service. No replay,
clock, fault-injection, or arbitrary-dispatch HTTP route was added. Browser fixtures use test-host
publisher/collector interruptions and clock advancement against actual memory persistence/HTTP;
they do not seed fake operation rows or synthesize UI success. Browser hosts use HTTP fixture
helpers rather than loading decorated Angular client source through Playwright's Node transformer;
the actual Angular client runs in the page and also has separate HTTP-backed unit coverage.

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
