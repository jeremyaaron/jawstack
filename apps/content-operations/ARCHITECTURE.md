# Content Operations Architecture and Protocols

Start with the [runbook and walkthrough](README.md). This guide records the implemented
authority, transaction, storage, asynchronous execution, recovery, and owned-lab protocols.
The [API](API.md), [workbench](WORKBENCH.md), and [synthesis boundary](INFRASTRUCTURE.md)
describe their respective interfaces. Phase-by-phase history stays in the
[iteration records](../../docs/iterations/002-content-operations/README.md).

The same content decisions and worker/job factories run in two explicit modes. Memory
uses volatile stores and a managed host pump; LocalStack uses guarded DynamoDB/S3 clients
and deployed stream -> EventBridge -> SQS -> Lambda consumers plus recurring Scheduler
targets. Neither mode authenticates production users or falls back to real AWS.

## Credential-Free Checks

From the repository root:

```sh
nvm use
pnpm install
pnpm build
pnpm --filter content-operations run typecheck
pnpm --filter content-operations run test
pnpm --filter content-operations run lint
pnpm --filter content-operations run build
```

These commands do not start Docker, load the token file, resolve AWS credentials, or
connect to any AWS service. The build creates a guarded browser bundle under `dist/web/`
and bundled Node 22 `spine.zip`, `publication.zip`, `jobs.zip`, and `recovery.zip`
Lambda archives under `dist/`; all four archives supply deployed lab handlers.
It also builds five separate synthesis-only archives under `dist/infra/`. The
[infrastructure guide](INFRASTRUCTURE.md) describes the local-only CDK composition,
credential-free synthesis command, JSON ingress boundary, and explicit lab differences.
Build the workspace once so the harness can bundle installed public package entrypoints.
Unit tests are explicitly restricted to `test/unit/**/*.test.ts`; live integration is a
separate script, never a token-dependent test in default discovery.

## Editorial Domain

The pure factories in `src/domain/resources.ts` expose:

- `contentItem`: `create`, `editDraft`, `submit`, `approve`, `requestChanges`, `reopenDraft`,
  and eligible `archive`. Content is the only editorial authority.
- `reviewTask`: internal-only `createSnapshot` and `applySnapshot` materialization
  primitives, not independent editorial commands. Its browser command map is empty.
- `asset`: internal-only snapshot creation/application from full content-owned attachment
  facts. Per-content projections retain removed/expired tombstones. Its UI command map is empty.

`src/shared/contracts.ts` and `src/shared/assets.ts` own strict state/input/version-1 fact schemas;
`src/shared/presentation.ts` shares browser-safe metadata and schemas without server
decisions. `src/domain/projections.ts` plans content/status/due-review and review history/
editor/pending membership, including explicit old-key deletions and stable sort keys.
Factories/imports do not generate IDs, start services, resolve credentials, or call AWS.

Credential-free headless composition through the memory runtime:

```ts
import { createMemoryRuntime } from "./src/application/runtime";
import { fixtureAuth } from "./src/shared/identities";

const app = createMemoryRuntime();
const result = await app.dispatch(
  {
    resourceType: "contentItem",
    commandName: "create",
    input: { title: "Release notes", body: "Draft release notes." },
    idempotencyKey: crypto.randomUUID(),
    requestContext: {},
  },
  fixtureAuth("author_1"),
);
await app.drainUntilIdle();
```

Dispatch supplies UUID resource IDs and accepts only an already-resolved identity; an HTTP
adapter must authenticate/allowlist before calling it. Fixture authentication is local-only.
Factories generate separate revision/review UUIDs lazily, with injectable `newId` for tests.

### Dispatch and Persistence

`src/application/workflow.ts` declares the shared workflow metadata, and
`src/application/persistence.ts` registers the existing command receipt/publication-attempt
records and pure contributions. `dispatch.ts`, `memory.ts` and `src/aws/persistence.ts`
are delegating composition, not independent dispatch, staging or transaction compilers.
JawStack owns scope/time capture, bounded replay, plan normalization/bounds, atomic memory
publication and DynamoDB compilation/error handling. The live publication-claim validator
and editorial/fact/attempt policies remain in Content.

This is command-only adapter composition during Iteration 3's staged migration. The existing
memory pump, stream dispatcher, SQS wrappers and failure service remain the sole active
delivery/recovery path until Phase 11. No shared driver is constructed or started, and no
second failure ledger is written. The memory notification writer shares the same backing
store without a clone/publish race across asynchronous command work.

- Every mutation requires a key of 1-200 ASCII letters, digits, `_`, `.`, `:`, or `-`.
  Retain the key for retries of the same input; generate another for a new intent. Scope is
  resource type, command, and resolved subject; the core fingerprint also includes target ID.
- Each invocation captures its own identity, request, scope, and server instant. Records
  expire logically at seven days. DynamoDB conditionally replaces an expired row even if
  TTL cleanup has not deleted it; live rows remain protected from competing writes.
- Concurrent equivalent retries return the original stored response, including its request/
  correlation metadata. A conflict or ambiguous SDK failure permits at most four strong
  replay lookups (0/10/25/50 ms pauses), never another mutation attempt. Different payloads
  conflict; stale user edits without an equivalent stored command remain conflicts.
- The shared planner composes one bounded, typed
  `commandReceipt` operation per successful resource version (`OPS#commandReceipt`, sort
  `<resourceType>#<resourceId>#<version>`). Its create-only condition participates in the
  primary/activity/outbox/projection/idempotency transaction. Receipts contain no bodies,
  credentials, or growing arrays. Worker-specific operation variants remain application-owned.
- The shared memory adapter serializes validated plans and publishes all records together. Both
  adapters share physical-key normalization, projection delete/put coalescing, conflicting
  put/duplicate action rejection, and a 60-action limit checked before any write. Exact old
  keys are deleted; the memory adapter does not silently erase other sorts for an item.
- Only public adapter APIs are imported; no caller-authored SDK fragments or conditions
  enter the command path. Supply a
  guarded DynamoDB client and owned table to `createDynamoPersistence`; dispatch itself
  never creates clients, resolves AWS credentials, or starts a service.

### Authority and Bounds

- Fixtures are `author_1`, `author_2`, `editor_1`, and `editor_2`. Resolved identity and
  claimed role must agree; forged extra roles do not promote an author. Authors manage
  only their own drafts; either editor can manage content and decide a review. These
  development/test identities are not production authentication.
- All non-create editorial inputs include `expectedVersion`, checked against the loaded
  state and again at commit by the public unit of work. Approve/request-changes also
  require the current review ID, revision UUID, and a nonblank decision note.
- Resource version, revision UUID, and review UUID are distinct. Changed drafts/reopens
  generate revisions; unchanged saves retain the revision but advance resource version.
  Submission/decisions preserve the revision. Review `sourceVersion` is the content
  version, not the secondary review row's own optimistic version.
- Submission freezes the complete submitted snapshot. Requested/decided/superseded facts
  retain it; later edits cannot rewrite old facts. Reopen/archive supersede pending
  reviews, and reopen clears approval/schedule. Archive removes active projections, not
  primary history. Content retains only its latest bounded review, not a growing history array.
- Titles are trimmed, nonempty, and at most 160 characters; plain-text body is at most
  32 KiB UTF-8; notes are at most 2,000 characters. Body whitespace is preserved and invalid
  Unicode rejected. Serialized snapshots/state/event payloads are bounded to 64/160/80 KiB.
- Editor assignments must be registered fixtures and due times future UTC instants with
  millisecond precision. Unknown input/state/event fields are rejected. Actor, approval,
  outcome, and storage identity are not trusted UI inputs. Stored and resulting state
  are validated, and each event schema checks its declared lifecycle outcome.

### Internal Commands

Scheduling and publication commands and the publication-object writer are implemented.
`publishNow` or an internal due request freezes an intent and queues a fact; draining the
memory pump claims it, writes/verifies its immutable JSON artifact, completes the content,
and delivers the outcome notification. Recurring job handlers and Temporal local-time/DST
conversion and deployed consumer Scheduler wiring are implemented.
Domain-only completion tests still use trusted metadata;
publisher tests additionally assert actual artifact bytes and digest.

Core requires commands and separates create from update, so the review resource has two
internal primitives. They require `review_projector`/`reviewProjector`, preserve submitted
fields, and reject stale source versions or regressing closed outcomes. A closed snapshot
can arrive before its older requested fact without restoring pending state. Shared handlers
now validate envelopes/sources, ignore older/equivalent snapshots, and reload on conflicts.
The asset primitives apply the same dedicated-projector, increasing-source-version, and
immutable-metadata rules, including terminal tombstones. Public ingress must reject snapshot
commands, `completeUpload`, `expireAsset`, and internal due/publication commands regardless of headers, and fixture
selectors never offer service identities. The loopback HTTP ingress enforces this allowlist.

Tests execute public commands against memory and SDK contract persistence without Work
Request helpers, direct event publication, or a second editorial authority. The live proof
below exercises the actual HTTP application and deployed editorial workers.

## Attachments and Uploads

- `registerAsset` and `removeAsset` require an owning author/editor, draft status, and
  `expectedVersion`. Registration generates a new asset UUID, revision UUID, immutable key
  `assets/<contentId>/<assetId>/original`, and one-hour deadline. Removal/expiry retain a
  full tombstone and change the draft revision; verified completion does not change membership.
- There are at most 10 active slots and 32 total retained slots, including tombstones.
  The latter is a deliberate development bound: registration stops at capacity instead of
  forgetting an object reference. Explicit maintenance ticks expire uploads/clean old unverified orphans; verified
  objects, including removed ones, are conservatively retained until explicit local reset.
- PNG, JPEG, and PDF bytes are limited to 10 MiB per file; declared size/type must match
  actual bytes and an allowed leading signature. Filenames are display-only Unicode text
  up to 255 characters; paths, controls, bidi controls, and markup delimiters are rejected.
  A filename, client checksum, or client storage key never supplies object authority.
- `createUploadService` accepts resolved identity, content/asset IDs, and a byte array or
  async byte stream. It strongly loads content, checks fixture ownership, draft/slot state
  and logical deadline, then reads under a 30-second deadline with at most two in-flight
  uploads per service instance. Excess admission is retryable; there is no unbounded queue.
- Memory and guarded local S3 adapters conditionally create, compute SHA-256, and verify
  readback bytes/type/size/digest. Matching retries succeed; different existing bytes fail
  without overwrite. Memory defaults to 128 objects/128 MiB (configurable within bounded
  limits). S3 permits only the owned local bucket/region and declared local endpoints,
  dummy credentials, final transport checks, finite SDK retries/timeouts, and at most three
  conditional 409 attempts. There is no overwrite or arbitrary-key deletion API; the internal
  cleanup interface permits conditional deletion only at generated asset-original keys.
- Only the internal upload verifier can run `completeUpload`. The service rereads and
  rechecks on at most three optimistic completion attempts; it never reapplies a stale
  decision after removal, expiry, or submission. A ready retry verifies the same bytes and
  returns the current slot without another mutation. An interrupted completion leaves an
  unready slot plus an immutable object; retrying the same bytes can complete it safely.
- `submit` rejects pending slots and freezes ready references (IDs, key, filename, type,
  size, digest), not raw bytes or retired slots. Approved/scheduled/published content cannot
  accept uploads or removal. Removing a reopened attachment does not delete its historical
  bytes. The dedicated janitor's `expireAsset` retires only due pending draft slots.

Compose `createMemoryObjectStore` from `src/application/object-store.ts` and
`createUploadService` from `src/application/uploads.ts` with the existing memory repository
and dispatcher for credential-free use. `createLocalS3ObjectStore` is explicitly local-only;
it is not a production AWS client factory. Shared snapshot handlers and the explicit memory
pump and loopback upload/download routes are implemented; see the [API guide](API.md).
Signature detection is not full media decoding,
sanitization, antivirus scanning, or permission to embed PDFs as active documents.

## Workers and Notifications

`src/domain/subscriptions.ts` advertises four implemented workers on `contentItem`:

- `materializeReview`: requested, decided, superseded, and reminder-recorded review facts.
- `materializeAsset`: registered, ready, removed, and expired asset facts.
- `publishContent`: publication requests/retries through the recoverable artifact protocol.
- `deliverNotification`: review requests/reminders to the assigned editor; review decisions and
  publication success/terminal failure to the author.

`src/application/workers.ts` supplies domain handlers bound through the public shared delivery adapter.
The shared protocol validates
the exact application/stage source (default `content-operations`), version-1 envelope, bounded
IDs/payloads, target identity, and strict fact outcome. This single-workspace consumer rejects
tenant-scoped envelopes. Source validation is not a substitute for authenticated ingress or
trusted queue wiring. Dispatch and workers must use the same explicit stage source.

Materializers strongly load the target, ignore older/identical source versions, reject
equal-version rewrites, and try at most three optimistic upserts. They use only the internal
snapshot commands, preserve correlation, and use the incoming event ID as command request ID
and downstream causation. Full closed/tombstone snapshots can arrive first. Neither
`reviewTask.snapshotApplied` nor `asset.snapshotApplied` has subscribers; there is no loop.
Reminder facts carry their original business instant, preserving replay identity and ordering.

The local notification sink is the delivery destination, not an email/Slack stub. Stable
SHA-256 delivery IDs derive from original event ID, fixture recipient, and versioned template.
Memory atomically inserts the delivery, typed operation, and two query rows; DynamoDB uses
one four-action conditional transaction. A competing or ambiguous success rereads the
original delivery. Business records have no TTL and are never evicted on transport-marker
expiry; different content at the same delivery ID conflicts. Memory defaults to 1,000
deliveries (bounded override up to 10,000); capacity rejects new records but permits retries.

`app.notifications.query({ recipientId?, limit?, cursor? })` pages all/fixture-recipient
views, 50 by default and 100 maximum. Rows also live in the memory repository's
`contentItem.notifications[.<fixtureId>]` projections, matching DynamoDB. Stored records
retain the first delivery's transport/correlation/causation metadata; replay does not rewrite
it. Reserved payload metadata `delivery: { originalEventId, generation, consumer, failureId }`
is strictly validated (generations 1-3) against the durable recovery request before effects
or cached-marker acknowledgement. Incomplete legacy two-field metadata now rejects rather
than bypassing durable replay authorization. There is no public payload submission/replay endpoint.

### Explicit Memory Processing

`createMemoryRuntime` composes persistence, dispatch, immutable objects, uploads, notifications,
workers, and pump without starting timers, a server, or AWS clients. Commands only commit to
the outbox. Call `app.pump.drain()` for one bounded pass or `app.drainUntilIdle()` for at most
20 passes (configurable up to 100). Each pass scans at most 50 outbox events and attempts
50 handlers by default; the explicit per-pass limit is 1-100. Concurrent drains serialize.

Retries occur at injected-clock cutoffs of +1 and +2 seconds and become terminal after three
attempts. `createFixtureClock(iso).now`/`.advance(ms)` makes this deterministic; a drain never
advances time or sleeps until a retry. Idle can therefore include deferred/terminal jobs.
Inspect `app.pump.inspect()` and the returned pending/terminal/next-attempt/backpressure
fields. Uncollected failed jobs retain their original event privately but expose only sanitized summaries.

The shared pump defaults to 200 pending/terminal jobs and 1,000 bounded seven-day transport
markers (each capacity configurable up to 10,000). Full marker capacity defers new work;
it never evicts live markers. Business-level source-version/delivery checks also prevent
duplicate effects after expiry. Whole event
fan-out is admitted before advancing the cursor. When failed jobs fill capacity, processing
backpressures rather than discarding events. Corrupt oversized outbox entries or changed
content at the same transport event ID stop a drain explicitly. Recreate the runtime after
resetting its dataset; do not clear the outbox underneath an existing cursor.

Memory processing is volatile and does not imitate EventBridge/SQS/Lambda infrastructure.
The memory HTTP composition manages pumping explicitly. Terminal memory jobs enter
the same durable collection/recovery protocol, and collected work releases its pump capacity.
Collection failure/live-claim deferral retains the job and retries at an injected-clock
one-second cutoff, without a successful worker marker. Separate bounded seven-day collection
caches never replace permanent failure/recovery history. Invalid/foreign envelopes stay
unacknowledged for investigation instead of being silently discarded. Tests exercise
the complete headless draft/upload/review/publication/notification flow and SDK notification
atomicity; the LocalStack gate also deploys the real consumer handlers.

## Scheduling and Publication State

- Editors can `schedule`, `reschedule`, `cancelSchedule`, `publishNow`, and `retryPublication`.
  Inputs require expected resource version and current approval/revision or publication/
  generation references. Schedule changes use server-generated generation UUIDs; cancel,
  reopen, archive, and publish remove old calendar/due keys in the same transaction.
- Schedule inputs require millisecond ISO timestamps with explicit offsets and valid IANA
  zones (or `UTC`). Store normalized UTC instants plus display-zone metadata. Times must be
  future at command time. This accepts absolute instants, not ambiguous local wall times;
  `localTimeToUtc` supplies strict local-time conversion/disambiguation for the UI forms.
- `requestDuePublication` requires the dedicated `due_worker`/`dueWorker` identity, current
  schedule generation/revision, and a due instant. `publishNow` can override an approved
  schedule immediately. Competing cancel/reopen/reschedule/due transitions have one versioned
  winner; an obsolete due generation cannot publish a reopened or rescheduled revision.
- Publication freezes the submitted/approved snapshot, approval, original schedule if any,
  one publication UUID, and `requestedAt`. Artifact identity is always
  `publications/<contentId>/<publicationId>/snapshot.json`; explicit retries preserve this
  intent/key/timestamp and change only the execution generation.
- Only `content_publisher`/`contentPublisher` can claim/complete/fail. Each claim needs a fresh
  attempt UUID and new idempotency key; only retries of that exact claim request reuse its
  key. The server issues a distinct fencing UUID and 90-second lease. A live competing
  claim conflicts. Both outcome commands require matching publication, generation, attempt,
  token, and an unexpired lease. Fences remain internal, not in event/query/history payloads.
- Dispatch rechecks successful claim responses against the current authoritative claim and
  server clock, including idempotent/competing-response replays. An expired, completed,
  replaced, or not-yet-started claim is not returned as a usable grant. New payloads at an
  old key still produce the ordinary idempotency conflict.
- Content stays `publishing` through queued/running/failed/stalled execution. Expired leases
  and terminal failures never unlock editing, attachment mutation, reopen, or archive.
  A failed or expired current cycle can be explicitly retried only without a live claim;
  an already-queued retry cannot burn another generation based on an older failure.
- Exhausted delivery collection can explicitly set `phase: "stalled"` with a durable
  `deliveryFailure` reference. It does not invent a worker attempt when none ran. Expired
  claims close as expired in the same domain commit; live claims defer collection. Editor
  retry clears the delivery marker and advances the bounded generation with the same intent.
- There are three attempts per generation and at most four generations (initial plus three
  editor retries). Storage-unavailable/interrupted attempts release the claim for another
  attempt; the third failure becomes terminal. Artifact mismatch/invalid snapshot fails
  the cycle immediately. Failures accept only an enum, not raw exception messages/stacks.
  A third expired lease remains stalled/locked until explicit retry or later reconciliation.
- Claimed/succeeded/failed/expired attempt facts produce typed immutable operation rows and
  all/per-content attempt projections in the primary transaction. Attempt UUIDs cannot be
  reused even in another generation. Reclaim/retry closes an expired attempt in the same
  commit as the successor state. Query rows retain stable start-time/attempt ordering and
  show the latest stage; immutable history has no growing root array or second write.
- Completion verifies role/fence/reference/size/digest shape, marks `published`, and emits
  an outcome. The publisher verifies actual object bytes before supplying this internal
  metadata. Metadata cannot choose a different key or exceed 80 KiB. Published content
  can be archived without deleting its artifact reference or approved history.

### Recoverable Publisher

`src/application/publication-artifact.ts` defines version-1 JSON: explicit field order,
normalized UTC milliseconds, attachments sorted by asset UUID, UTF-8 with one trailing LF,
and SHA-256 over those exact bytes (at most 80 KiB). The artifact contains only frozen intent,
not attempt IDs, leases, execution generations, completion times, or current wall time.
Retries therefore recover the same key, bytes, and digest.

`createPublisher` strongly rereads authority, acquires a fresh fenced attempt, conditionally
creates/verifies the artifact, then completes the domain transaction. Both memory and guarded
S3 adapters refuse different existing bytes; S3 also verifies type, length, digest, and
content/publication identity metadata with bounded streaming. A private object written before
completion is not a completed publication. Live competing claims throw for retry rather than
being acknowledged. Old generations are ignored; completed matching deliveries are read-only.

Transient failures record a failed attempt and release its lease; corruption terminalizes
the cycle immediately. A process crash leaves the claim until expiry. Tests inject exact
`afterClaim`, `afterObjectWrite`, `beforeCompletion`, and `afterCompletion` interruptions
through factory callbacks only, never environment switches or public endpoints. A late worker
cannot complete or fail its successor. Explicit retries preserve the original artifact intent.

`src/aws/publication.ts` bundles the shared protocol behind the public `SqsWorkerAdapter`.
It validates the whole bounded batch, queue ARN, exact source, envelope, and subscribed fact
before any marker lookup. Processing markers follow domain completion, never claim/object
creation. Redelivery after a marker gap or physical marker expiry uses domain deduplication.
`publication.zip` exports `publisher` as the deployed Lambda handler. Lambda S3 construction
requires the exact owned publisher context and fixed worker endpoint with dummy credentials.

## Due Work and Maintenance

`createContentJobs` exposes four named jobs, without starting timers or running work on import:
`duePublication`, `dueReview`, `expireUploads`, and `cleanupOrphans`. Memory use is explicit:

```ts
await app.jobs.tick("duePublication");
await app.jobs.tick("dueReview");
await app.jobs.tick("expireUploads");
await app.jobs.tick("cleanupOrphans");
await app.drainUntilIdle();
```

Use the fixture clock to make work due; ticking never advances it or waits for future work.
A tick queries at most 50 one-candidate pages and stops admitting work after 20 monotonic
seconds (smaller bounded `maxItems`/`maxMs` overrides are available). A current SDK operation
and checkpoint cleanup can finish afterward; all SDK requests retain finite retry/timeouts.
Result fields expose `busy`/`yielded`/`completed`, examined/succeeded/ignored counts, and
bounded sanitized item failures. Item failures advance the cursor so later work is not
starved; the next completed pass restarts from the oldest due item. A time-exhausted candidate
that has not attempted its effect keeps its old position.

The memory/DynamoDB `JobStore` keeps one permanent checkpoint per name with a 30-second
UUID-fenced lease, revision, fixed pass cutoff, and opaque public query cursor. Save progress
after each candidate/empty service page; release on normal exit. Overlapping ticks return
`busy`; a crashed owner expires, and a successor resumes its saved position. Conditional
checkpoint writes reject stale owners even with an old clock. A changed clock never changes
an ongoing pass's query bound; newly due items enter the next pass. Deleted cursor boundary
items do not prevent continuation. These records are application-owned, not core item kinds.

Jobs strongly reread content, not secondary resources. Publication checks current schedule/
revision/generation and due instant before the internal command. Review reminders use the
current pending review/revision and server UTC day. `recordReviewReminder` commits increasing
`lastReminderDay`, source version, and the reminder fact atomically, without changing the
draft revision or snapshot. A repeated or regressed day cannot send again. Closed/superseded
reviews are not eligible; the reminder notification goes through the ordinary outbox/sink.

Expiry targets pending draft slots at their logical deadline. Cleanup considers only retired,
never-verified slots and requires both retirement and object age to be at least 24 hours.
It checks strong content authority twice, refuses current review/publication references,
and never uses `asset` materialization as deletion authority. S3 rechecks metadata, rejects
versioned/suspended buckets, and deletes with the observed ETag; changed/young/missing objects
do not count as deletions. Clock rollback cannot relax age checks. Verified historical
objects, publication JSON, archived content, missing/corrupt authority, and every tombstone
are retained. Even after deletion, tombstones are not reclaimed in this phase: this preserves
identity against late writers and keeps the 32-retained-slot bound explicit.

`src/shared/time.ts` imports pinned `@js-temporal/polyfill` without patching globals. Local
date/time plus a valid IANA zone converts with `disambiguation: "reject"`; DST gaps/folds
(including half-hour transitions) require correction. Review/schedule command inputs require
millisecond ISO times with explicit offsets and normalize to UTC; server decisions still
validate future times. Explicit offsets can identify either side of a fold without guessing.

`jobs.zip` exports `scheduled`, composing the real jobs with DynamoDB checkpoints and guarded
S3 behind the public Scheduler target adapter. The exact owned jobs Lambda context is allowed
alongside the publisher's context. SDK provisioning declares four enabled recurring schedules,
their fixed target inputs, execution grants, and a retained failed-target queue.

Published/terminal-failure facts include `outcomeAt` from the completed attempt. Versioned
local notification templates use this business instant and original event ID, so replay
cannot duplicate a delivery or change its ordering. There are no email/provider side effects.

## Failures and Recovery

`createFailureService` shares policy between memory, the bundled SQS collector/worker,
and the development CLI. Each deterministic SHA-256 failure ID is scoped to consumer and
original transport event ID. One validated original envelope is retained privately, with
an immutable fingerprint, at most four collection stages (original plus three replays),
and at most three operator recovery requests. Memory defaults to 1,000 records (bounded
override up to 10,000); capacity rejects new failures without evicting existing identities.
Business history has no TTL and lasts for the development dataset.

Collection persists a pending record before publication reconciliation. A live matching
claim throws for later retry; an expired claim closes as expired, while queued exhausted
delivery becomes explicitly stalled. Stalling emits the ordinary publication outcome fact
without inventing an execution attempt. Repeated collection completes a partial record;
late failures cannot replace a newer generation or completed artifact. The source message
is acknowledged/collector-marked only after applicable reconciliation is durable. Invalid
source/envelope/consumer or unrecorded replay traffic remains unacknowledged, requiring
investigation in the DLQ rather than creating an infinite collector-DLQ chain.

Replay is editor-only and limited to `materializeReview`, `materializeAsset`, and
`deliverNotification` failures. It loads the stored fact, never a supplied payload, URL,
queue, or consumer override. A fresh transport UUID/time carries original business payload,
correlation/actor, causation to the original event, and targeted `delivery` metadata.
Recovery state, its operations projection, and a create-only public outbox item commit in
one transaction (or one non-yielding memory commit). There is no direct `PutEvents` or SQS
send. A lost CLI response can be retried with the same request UUID; an already queued cycle
does not consume another. The next cycle requires collected failure of the previous one.
Successful replay marks its history resolved before transport acknowledgement; cached and
expired-marker redeliveries still rely on permanent business deduplication.

Publication uses the existing editor `retryPublication` command instead of envelope replay.
Its authoritative generation must advance before a new request is queued, with at most
three manual retries and the same frozen bytes/key. Recurring job ticks resume through their
checkpoints and next invocation, not arbitrary fact replay. Scheduler delivery failures and
asynchronous job execution failures are retained in the owned schedule-failures queue; they
are diagnostic service envelopes, not replayable content facts. No collector acknowledges
or discards those envelopes. Scheduler retry fidelity is not established by the emulator.

In a memory runtime, use `app.failures.inspect(fixtureAuth("editor_1"))` or
`app.failures.replay(failureId, fixtureAuth("editor_1"), crypto.randomUUID())`, then drain
the pump. Inspection returns bounded redacted summaries/history, not the private envelope.
The CLI operates only against a provisioned, ownership-tagged local lab; it never loads
real AWS credentials or accepts an AWS runtime/endpoint override:

```sh
pnpm --filter content-operations jobs:inspect --actor editor_1
pnpm --filter content-operations jobs:inspect <failureId> --actor editor_1
pnpm --filter content-operations jobs:replay <failureId> --actor editor_1 --request-id <uuid>
```

`--lab <id>` selects an owned local instance. List inspection accepts `--limit` (1-100,
default 50) and `--cursor`; replay accepts an optional stable `--request-id` (otherwise
generated). These are development fixture identities, not production authentication.
`recovery.zip` exports `collector` and `worker`, using the framework SQS adapter with
whole-batch retry and validated fixed consumer/queue names. The entire batch is snapshotted
and validated before marker lookup; recorded replay authorization also precedes cached
markers. Non-targeted workers may acknowledge targeted fan-out copies as ignored without
executing business effects. Consumer wrappers explicitly set seven-day marker TTLs rather
than inheriting the framework's fourteen-day default. Each consumer and collector is deployed
with its own execution role and fixed queue ARN; the feasibility spine is retained as a regression.

## LocalStack Prerequisites

- A running Docker engine with Compose v2 and room for LocalStack and concurrent Node Lambdas.
  The final gate ran on an 8 GiB ARM64 host with other expensive gates stopped.
- Port 4566 available on loopback.
- A LocalStack account on the free non-commercial Hobby plan, not a paid trial.
- A LocalStack token placed in `.env.localstack` in this directory:

```dotenv
LOCALSTACK_AUTH_TOKEN=<your token>
CONTENT_OPS_LOCALSTACK_PLAN=hobby
```

The file is Git-ignored. Do not paste the token into chat, commit it, or run commands that
dump Compose/container environments. The plan flag records user attestation, not a
programmatic license audit. Environment variables may supply the same two settings in CI.

The image is pinned to LocalStack `2026.10.0` and its multi-architecture SHA-256 digest in
[private local-lab configuration](../../tooling/local-lab/src/config.ts). The shared
lifecycle generates its own bounded Compose document; the app no longer owns a second
Compose topology. This does not use a paid asset-deployment feature or real AWS deployment.
The lab is ephemeral; recreation discards data, and images remain cached after teardown.

Finite service provisioning/reset also belongs to that private tooling. Content registers
its resource configurations and grants in `src/lab/application-topology.ts` and captures
prebuilt archive identities in `scripts/lab-profile.ts`. The launcher delegates ordered,
ownership-checked provisioning/reset; application scenarios and sentinels stay app-owned.
The private routing inventory is not the public workflow runtime's bindings document;
Content command, failure stores, recovery orchestration, SQS wrappers and memory pumping now
delegate to public workflow adapters. `application/delivery.ts` binds domain handlers;
`application/failures.ts` retains editor authorization and publication reconciliation.
`aws/profile.ts` derives subscriptions and queue/function bindings from the workflow manifest.
The CDK stack opts into `recoverableWorkers`, retaining its S3/job grants. Existing local
transport guards and finite shared lab tooling remain the local execution boundary; Content
uses explicit borrowed clients, not a second public-local client pool or host processing loop.

Docker socket access gives the emulator substantial privileges on the local Docker host.
Use the trusted pinned image on a development machine or isolated runner, not as a sandbox
for untrusted code. Do not mount real credential directories.

## Run the Application Gate

From the repository root:

```sh
pnpm --filter content-operations run local:up
pnpm --filter content-operations run local:provision
pnpm --filter content-operations run verify:local --confirm-reset
```

This is a destructive, approximately 15-20 minute integration gate, not a health check.
It resets the owned dataset, reprovisions and repeats the happy path, then shuts down
the lab. A pass includes final teardown; start/provision again for interactive use.
Failures also attempt ownership-checked shutdown and retain the manifest if cleanup
cannot be proved. Sanitized results are atomically recorded in
`.localstack/<lab-id>-evidence.json`, including a failed/no-go result when cleanup fails.

The commands create a dedicated `jawstack-content-ops-dev` Compose project/network and
app-owned local resources: one DynamoDB table/stream, one EventBridge bus with five rules,
four application queues/four worker DLQs, a retained schedule-failures queue, the proof
queue/DLQ, one private S3 bucket, five schedules, twelve IAM roles, thirteen Lambda functions,
and seven-day logs. Lambda ZIPs are uploaded through the SDK. The four application schedules
are enabled; the proof schedule is enabled only during verification. The pure
`src/aws/profile.ts` declares application names, subscriptions, bundles, and bounds for
CDK comparison. The shared spine dispatcher publishes actual application outbox facts.

For interactive use, start `dev:api:local`, seed with `seed --runtime localstack`, and start
`dev:web` as described in [the API guide](API.md). No UI/domain change is needed. Seeding
commits authoritative states/intents; materializers and publication finish asynchronously.
Seed never resets or overwrites an existing content ID. Stop the API before reset/down.

The application gate starts an ephemeral loopback API, creates a draft, uploads/downloads
real PNG bytes, submits and approves a frozen review, then schedules it five seconds ahead.
It waits up to three minutes for an **automatic** rate-triggered due job and the deployed
publisher, checks exact immutable JSON bytes/digest and one logical S3 artifact, and waits
for three unique review/publication notifications and one succeeded attempt. It also checks
materialized asset/review authority, published outbox and worker completion markers, bounded
HTTP queries, ownership/internal-command denials, stale conflicts, and metadata redaction.
There is no host pump, direct consumer invocation, or direct event publication in this path.

The proof executes the `spineProof.create` command with a scoped idempotency key using
public JawStack APIs. The same transaction stores state, activity, projection, outbox, and
idempotency records. Its DynamoDB stream invokes the real outbox dispatcher Lambda;
EventBridge routes the event to SQS; the actual worker writes a conditional S3 artifact and
an idempotent DynamoDB receipt.
Verification checks the stored records, response replay, correlation, published outbox,
and one logical receipt. It does not invoke the worker directly or publish a substitute event.

The extended gate also checks concurrent conditional S3 writes, readback/digest verification,
rejection of a conflicting body, and the configured bucket public-access block. It enables
a `rate(1 minute)` schedule, observes an automatic target invocation and its downstream
artifact, and disables the schedule in a `finally` block. No manual trigger API is used.

A deliberately failing command goes through the same real stream/bus/queue path. The
worker records receive counts 1, 2, and 3 before throwing. Actual SQS redrive moves the
message to the DLQ; a collector persists the original event before returning successfully.
The gate waits for that receipt, the collector marker, and an empty DLQ.

### Deployed Failure Matrix

The gate separately builds a verification-only archive and temporarily installs it on
the eight owned application workers/collectors. It wraps the same production execution
factories with dependency fault hooks; normal lab and synthesis bundles contain no fault
control reader, environment switch, or HTTP fault route. Function tags, handler, manifest
owner, and standard archive hashes must match before any swap. Original archives are
restored and their hashes checked in `finally`, including on scenario failure.

Owned, run-scoped DynamoDB controls and actual Lambda receipt observations exercise:

- A one-shot transient publisher failure, then automatic SQS retry.
- Interruption after the immutable S3 write, an unexpired-lease duplicate, and automatic
  lease-expiry recovery with one expired/one succeeded attempt and identical object bytes.
- Three real terminal publisher receives, actual redrive, and collector interruption
  after the durable failure record but before reconciliation/acknowledgement. The source
  remains in the DLQ until automatic collector retry reconciles it.
- Idempotent editor retry to generation two and owned CLI replay of a terminal notification
  failure, producing one recovery cycle and one business delivery.
- Completed duplicates, older review facts, obsolete publication generations, and a late
  collector. Selected transport markers are deleted to test permanent business guards.
- Paged attempts/notifications/failures, invalid cursors, explicit missing-table/bucket
  failures, and unsafe endpoint/inherited-credential probes with zero network requests.

Application visibility remains 180 seconds, with three receives and normal publication
leases; the gate neither advances clocks nor accelerates visibility. Its delivery deadline
is fifteen minutes. Original happy-path events use the actual stream -> bus -> queue ->
Lambda path. Exact committed-fact republishes through EventBridge and a late original copy
through the owned DLQ are **diagnostics**, reported separately; no host worker or direct
Lambda invocation substitutes for deployed execution.

### Historical Adapter Proofs

Phases 3-14 also ran the following direct adapter proofs. Their implementation and recorded
evidence remain available, but `verify:local` no longer executes these injected-clock/crash
fixtures alongside live application consumers: their intentional interruptions would race
deployed workers. Unit/contract regressions remain active. The deployed failure matrix
above replaces those direct fixtures for full integration acceptance.

The paging proof seeded 260 projection records with 8 KiB payloads, tied timestamps, and
both existing sort-suffix forms, plus seventeen activity records. It checks an actual
service-shortened page, continuation after an empty item-kind-filtered page, ascending/
descending half-open ranges, and complete ordered parity with memory. Real public units
of work move a projection sort and partition with explicit old-key deletion; a deleted
boundary key still permits continuation. All fixture data stays in the owned table and
is removed by the same reset. Batch writes are limited to 25 items and three attempts.

The scoped transaction proof executes consumer commands against both adapters: six concurrent
creates and edits, exact response replay, conflicting payloads, distinct command/subject
scopes, seven-day logical expiry without physical deletion, and auxiliary/primary conditional
rollback. It checks status/due deletion and exact sort/partition moves with duplicate sort
aliases. These fixtures stay in the owned table and are removed by reset as well. The
command-receipt history is application-owned, not a new public JawStack item kind.

The attachment proof uses actual S3 writes/readback and DynamoDB content commands. It
injects an interruption after object creation, confirms the slot remains pending, rejects
different retry bytes, and recovers matching completion. It checks concurrent conditional
creation, one logical key, frozen review references, approved-upload rejection, retained
removed bytes, and expiry without an object write. PNG/JPEG/PDF signature fixtures round
trip; this is not evidence of full media decoding. These objects are removed by owned reset.

The publication proof runs the shared publisher directly against real local DynamoDB/S3.
It interrupts after object creation, observes a still-running claim and private artifact,
rejects an early competitor, advances the injected clock by 90 seconds, and recovers one
logical artifact plus expired/succeeded attempt history. A duplicate does not mutate completed
state. A second exact-key corrupt object causes terminal failure without overwrite. This
proves the consumer object/transaction boundary, not its deployed SQS route; the separate
spine continues to prove actual stream/bus/queue/Lambda delivery without direct invocation.

The jobs proof uses real DynamoDB checkpoints and S3 conditional deletion with an injected
clock. It checks overlapping publication ticks, review checkpoint restart and daily dedup,
slot expiry, young-object retention, old-orphan deletion with tombstone retention, and
expired-lease takeover/stale-writer rejection. This is a direct shared-service proof, not
consumer Scheduler deployment. The separate automatic feasibility schedule is still tested.

The recovery proof executes owned CLI inspection/replay and checks the transactional replay
outbox against real DynamoDB. Direct shared SQS adapters execute one local notification,
then physical deletion of its exact marker still leaves one business delivery. A publication
interrupted after object creation retains a pending failure record while its claim is live;
the collector has no completion marker until lease expiry/reconciliation. Editor retry
recovers one artifact, and a late collector delivery cannot replace success. These are
direct adapter checks, not deployed consumer queue evidence; the separate spine still proves
actual redrive/collection. All fixtures are discarded by the same owned reset.

The HTTP proof starts the actual loopback router with the guarded LocalStack runtime. It
checks owned/private/unversioned storage at startup, real DynamoDB commands/strong reads/
bounded projections, actual S3 upload/download bytes, stale conflicts, internal-command and
ownership denials, metadata redaction, and denial of pending downloads/uncommitted previews.
Its original result did not claim deployed consumers. The current application gate above
extends it to the actual worker/Scheduler routes while retaining the ingress negative checks.

### Reset Evidence

`--confirm-reset` is required because the full gate then deletes the owned proof dataset,
checks that a separately owned sentinel table and its nonce survived, and reprovisions
and reruns both the successful spine and real application workflow. It removes its exact test sentinel after checking owner
and contents. Do not point this resettable harness at application data you want to keep.
Allow approximately 15-20 minutes for the complete gate, including real rate ticks and
normal application visibility/redrive waits; cold images or a busy host can take longer.

The CLI prints sanitized results and writes running/passed/failed evidence under `.localstack/`.
Only a complete gate yields `decision: go`; failed gates record `no-go`, not a stale pass.
Ownership manifests there are required for safe lifecycle operations; do not delete them
while the lab runs. Use `CONTENT_OPS_LAB_ID` (1-16 lowercase letters/digits/hyphens) to
select another explicit instance; only one instance can bind the fixed host port at a time.

## Reset and Stop

Reset only resources owned by the current manifest, leaving the emulator running:

```sh
pnpm --filter content-operations run local:reset --confirm-reset
pnpm --filter content-operations run local:provision
pnpm --filter content-operations run verify:local --confirm-reset
```

Stop the entire owned ephemeral lab and remove its container/network:

```sh
pnpm --filter content-operations run local:down
```

A successful verification has already done this; no second down is required.

Reset preflights ownership tags on every known resource before deleting anything. It also
checks the expected event-source mappings. Provisioning refuses pre-existing named
resources rather than adopting or retagging them. On interrupted provisioning, use reset
with the intact manifest; on a failure, the manifest is retained for recovery.

Reset stops the schedule, removes mappings/functions and their warm containers, empties
only the owned unversioned bucket within a 10,000-object/10-page limit, and removes the
remaining owned resources. It refuses foreign tags, unexpected targets/mappings, enabled
bucket versioning, and broken pagination rather than silently broadening cleanup.

Lambda runtime containers carry manifest-owner, lab, and runtime-kind labels supplied
by the emulator. Cleanup checks those labels, the exact declared function-name pattern,
and inspected IDs for all candidates before mutation. Down stops the emulator first,
then stops/removes proven running and exited/created orphan runtimes. A prefix alone
never authorizes removal. The gate also creates owned running/exited diagnostics and a
separately owned lookalike from the cached runtime image. One shell-entrypoint fixture
must be observed `exited`, not merely `created`; another runs a bounded sleep independent
of the emulator's child registry. A foreign lookalike must prevent shutdown before the
emulator or owned running fixture is stopped. After the test removes only its exact
foreign sentinel, final down must stop/remove the running orphan and remove the exited
fixture. It verifies zero matching containers/networks before deleting the manifest.
Images remain.

S3 creation and tagging are not one atomic API operation. If interrupted between them,
reset refuses an untagged bucket; recreate the owned ephemeral emulator with `local:down`
then `local:up`, rather than forcibly adopting or deleting an unverified bucket.

The sentinel proves service-resource cleanup leaves unrelated resources in that emulator
alone. `local:down` intentionally discards the entire dedicated emulator's state; it cannot
preserve another service dataset stored inside that same disposable container. It does not
stop other Compose projects or delete their Docker resources.

## Isolation and Limits

Host SDK requests are restricted to `http://127.0.0.1:4566`; Lambda SDK requests target
`http://localstack:4566` on the dedicated network. Every client has explicit dummy
credentials, region, finite retries, and a final HTTP transport destination guard. Unexpected
queue origins/names are rejected. Host launchers reject inherited AWS credential/profile,
role, endpoint, or credential-file settings; start from a clean shell rather than relying
on a default AWS profile. No local command has a real-AWS fallback.

Readiness and service waits are bounded. A cold initial Lambda runtime image pull may take
time; if it exceeds the limit, inspect the owned local logs privately, then reset/retry.
Docker/service errors are summarized instead of dumping potentially sensitive output.

The feasibility test profile uses 5-second worker/collector timeouts, 30-second source/DLQ
visibility, three receives before redrive, and maximum concurrency 2. Dispatcher/Scheduler
functions retain 30-second timeouts. These short proof bounds make redrive practical to
observe. Actual application functions use 30-second timeouts, 180-second queue/DLQ visibility,
batch size 1, concurrency 2, three source receives, four-day source retention, and fourteen-day
DLQ retention. Publication roles can read assets and read/write publication objects; only
jobs can delete asset objects. Materializers/notifications/collectors have no S3 permissions.

The gate verifies local S3/Scheduler/SQS integration, not AWS-equivalent IAM enforcement,
Scheduler failed-delivery retries, API Gateway/CloudFormation deployment, production auth,
or exactly-once external effects. No AWS deployment occurs. Scheduler retry emulation has
documented limitations; successful automatic delivery here does not validate its retry policy.
Do not use this harness for production jobs.

Planning and observed results:

- [Implementation Plan](../../docs/iterations/002-content-operations/implementation-plan.md)
- [Technical Design](../../docs/iterations/002-content-operations/technical-design.md)
- [LocalStack Evidence](../../docs/iterations/002-content-operations/localstack-evidence.md)
