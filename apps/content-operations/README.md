# Content Operations

Private first-party JawStack consumer. Iteration 2 Phases 0-1 supply a LocalStack feasibility
harness for the event spine, object storage, scheduling, failure collection, and safe reset.
Phase 3 extends it with memory/DynamoDB paged-query parity and transactional projection moves.
Phase 6 adds a headless content/review domain, strict schemas, fixture identities, and
browser-safe presentation metadata. Phase 7 adds scoped dispatch and atomic memory/DynamoDB
persistence. Phase 8 adds content-owned attachment slots, an asset read-model primitive,
immutable memory/local-S3 objects, and a bounded upload service. Phase 9 adds shared review/
asset handlers, a local notification destination, and an explicit memory pump. Phase 10
adds scheduling/publication intent, fenced execution state, and atomic attempt history.
Actual publication-object execution, consumer Lambda/queue wiring, HTTP, and Angular UI remain later work; the live lab still
exercises the separate event spine, direct transactions, and attachment protocol.

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
connect to any AWS service. The build creates a bundled Node 22 Lambda ZIP under `dist/`.
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
- `src/aws/persistence.ts` composes exported JawStack builders with one bounded, typed
  `commandReceipt` operation per successful resource version (`OPS#commandReceipt`, sort
  `<resourceType>#<resourceId>#<version>`). Its create-only condition participates in the
  primary/activity/outbox/projection/idempotency transaction. Receipts contain no bodies,
  credentials, or growing arrays; worker-specific operation variants remain later work.
- The memory adapter serializes staged commits and publishes all records together. Both
  adapters share physical-key normalization, projection delete/put coalescing, conflicting
  put/duplicate action rejection, and a 60-action limit checked before any write. Exact old
  keys are deleted; the memory adapter does not silently erase other sorts for an item.
- No framework internals or generic arbitrary-write extension point are exposed. Supply a
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

### Staged Capabilities

Scheduling and publication domain commands are implemented, but the publication-object
writer is not. `publishNow` or a due request currently freezes an intent and queues a fact;
draining the memory pump does not publish it. Phase 11 supplies actual serialization,
conditional object writes/readback, and the publisher handler. Automatic due jobs and
Temporal local-time/DST conversion remain Phase 12. Domain completion tests use trusted
artifact metadata without claiming an object was created.

Core requires commands and separates create from update, so the review resource has two
internal primitives. They require `review_projector`/`reviewProjector`, preserve submitted
fields, and reject stale source versions or regressing closed outcomes. A closed snapshot
can arrive before its older requested fact without restoring pending state. Shared handlers
now validate envelopes/sources, ignore older/equivalent snapshots, and reload on conflicts.
The asset primitives apply the same dedicated-projector, increasing-source-version, and
immutable-metadata rules, including terminal tombstones. Public ingress must reject snapshot
commands, `completeUpload`, `expireAsset`, and internal due/publication commands regardless of headers, and fixture
selectors must never offer service identities. No HTTP ingress is exposed yet.

Tests execute public commands against memory and SDK contract persistence without Work
Request helpers, direct event publication, or a second editorial authority. The live proof
below includes consumer transactions, not deployed editorial workers or an HTTP application.

## Attachments and Uploads

- `registerAsset` and `removeAsset` require an owning author/editor, draft status, and
  `expectedVersion`. Registration generates a new asset UUID, revision UUID, immutable key
  `assets/<contentId>/<assetId>/original`, and one-hour deadline. Removal/expiry retain a
  full tombstone and change the draft revision; verified completion does not change membership.
- There are at most 10 active slots and 32 total retained slots, including tombstones.
  The latter is a deliberate development bound: registration stops at capacity instead of
  forgetting an object reference. Automatic expiry/orphan cleanup remains Phase 12. Verified
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
  conditional 409 attempts. Neither adapter exposes deletion or an overwrite operation.
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
pump are implemented; HTTP upload/download routing remains Phase 14. Signature detection is not full media decoding,
sanitization, antivirus scanning, or permission to embed PDFs as active documents.

## Workers and Notifications

`src/domain/subscriptions.ts` advertises exactly three implemented workers on `contentItem`:

- `materializeReview`: requested, decided, and superseded review facts.
- `materializeAsset`: registered, ready, removed, and expired asset facts.
- `deliverNotification`: review requests to the assigned editor and decisions to the author.

`src/application/workers.ts` supplies the shared transport-independent handlers. They validate
the exact application/stage source (default `content-operations`), version-1 envelope, bounded
IDs/payloads, target identity, and strict fact outcome. This single-workspace consumer rejects
tenant-scoped envelopes. Source validation is not a substitute for authenticated ingress or
trusted queue wiring. Dispatch and workers must use the same explicit stage source.

Materializers strongly load the target, ignore older/identical source versions, reject
equal-version rewrites, and try at most three optimistic upserts. They use only the internal
snapshot commands, preserve correlation, and use the incoming event ID as command request ID
and downstream causation. Full closed/tombstone snapshots can arrive first. Neither
`reviewTask.snapshotApplied` nor `asset.snapshotApplied` has subscribers; there is no loop.
Publication/reminder subscriptions are not advertised before those handlers exist.

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
it. Reserved payload metadata `delivery: { originalEventId, generation }` is strictly
validated (generations 1-3) and excluded from the fact fingerprint. Recovery/replay commands
that produce it remain Phase 13; there is no arbitrary public replay endpoint.

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
fields. Failed jobs retain their original event privately but expose only sanitized summaries.

The pump defaults to 200 pending/terminal jobs and 1,000 bounded seven-day transport markers
(each capacity configurable up to 10,000). Marker capacity may evict old cache entries;
business-level source-version/delivery checks still prevent duplicate effects. Whole event
fan-out is admitted before advancing the cursor. When failed jobs fill capacity, processing
backpressures rather than discarding events. Corrupt oversized outbox entries or changed
content at the same transport event ID stop a drain explicitly. Recreate the runtime after
resetting its dataset; do not clear the outbox underneath an existing cursor.

Memory processing is volatile and does not imitate EventBridge/SQS/Lambda infrastructure.
Automatic managed pumping belongs to later HTTP composition. Durable failure collection/
manual recovery and live consumer queues are not implemented by this phase. Tests exercise
the complete headless draft/upload/review/notification flow and SDK notification atomicity;
the live LocalStack harness below has not been extended to deploy these consumer handlers.

## Scheduling and Publication State

- Editors can `schedule`, `reschedule`, `cancelSchedule`, `publishNow`, and `retryPublication`.
  Inputs require expected resource version and current approval/revision or publication/
  generation references. Schedule changes use server-generated generation UUIDs; cancel,
  reopen, archive, and publish remove old calendar/due keys in the same transaction.
- Schedule inputs require millisecond ISO timestamps with explicit offsets and valid IANA
  zones (or `UTC`). Store normalized UTC instants plus display-zone metadata. Times must be
  future at command time. This accepts absolute instants, not ambiguous local wall times;
  local-time conversion/disambiguation still belongs to Phase 12.
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
  an outcome. Its byte metadata is trusted internal input until Phase 11 adds the actual
  object verifier. Metadata cannot choose a different key or exceed 80 KiB. Published content
  can be archived without deleting its artifact reference or approved history.

No `publishContent` subscription is registered yet, and publication notifications are not
advertised as operational. Tests cover decisions and memory/SDK transaction contracts, not
artifact existence, a deployed publisher, an automatic due evaluator, or production auth.

## LocalStack Prerequisites

- A running Docker engine with Compose v2 and enough RAM for LocalStack plus four Node Lambdas.
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
`compose.yaml`. This does not use a paid asset-deployment feature or real AWS deployment.
The lab is ephemeral; recreation discards data, and images remain cached after teardown.

Docker socket access gives the emulator substantial privileges on the local Docker host.
Use the trusted pinned image on a development machine or isolated runner, not as a sandbox
for untrusted code. Do not mount real credential directories.

## Run the Feasibility Gate

From the repository root:

```sh
pnpm --filter content-operations run local:up
pnpm --filter content-operations run local:provision
pnpm --filter content-operations run verify:local --confirm-reset
```

The commands create a dedicated `jawstack-content-ops-dev` Compose project/network and
app-owned local resources: DynamoDB table/stream, EventBridge bus/rule, SQS queue/DLQ,
private S3 bucket, Scheduler group/schedule, two IAM roles, four Lambda functions, and
bounded-retention logs. Lambda ZIPs are uploaded through the SDK.

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

The paging proof seeds 260 projection records with 8 KiB payloads, tied timestamps, and
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

`--confirm-reset` is required because the full gate then deletes the owned proof dataset,
checks that a separately owned sentinel table and its nonce survived, and reprovisions
and reruns the successful spine. It removes its exact test sentinel after checking owner
and contents. Do not point this resettable harness at application data you want to keep.
Expect a few minutes, including the real rate tick and visibility/redrive waits.

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

Reset preflights ownership tags on every known resource before deleting anything. It also
checks the expected event-source mappings. Provisioning refuses pre-existing named
resources rather than adopting or retagging them. On interrupted provisioning, use reset
with the intact manifest; on a failure, the manifest is retained for recovery.

Reset stops the schedule, removes mappings/functions and their warm containers, empties
only the owned unversioned bucket within a 10,000-object/10-page limit, and removes the
remaining owned resources. It refuses foreign tags, unexpected targets/mappings, enabled
bucket versioning, and broken pagination rather than silently broadening cleanup.

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
functions retain 30-second timeouts. These short test bounds make redrive practical to
observe; they are not a change to the later application's 30-second/180-second design.

The gate verifies local S3/Scheduler/SQS integration, not AWS-equivalent IAM enforcement,
Scheduler failed-delivery retries, API Gateway/CloudFormation deployment, production auth,
or exactly-once external effects. No AWS deployment occurs. Scheduler retry emulation has
documented limitations; successful automatic delivery here does not validate its retry policy.
Do not use this harness for production jobs.

Planning and observed results:

- [Implementation Plan](../../docs/iterations/002-content-operations/implementation-plan.md)
- [Technical Design](../../docs/iterations/002-content-operations/technical-design.md)
- [LocalStack Evidence](../../docs/iterations/002-content-operations/localstack-evidence.md)
