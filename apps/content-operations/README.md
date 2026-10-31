# Content Operations

Private first-party JawStack consumer. Iteration 2 Phases 0-1 supply a LocalStack feasibility
harness for the event spine, object storage, scheduling, failure collection, and safe reset.
Phase 3 extends it with memory/DynamoDB paged-query parity and transactional projection moves.
Phase 6 adds a headless content/review domain, strict schemas, fixture identities, and
browser-safe presentation metadata. Phase 7 adds scoped dispatch and atomic memory/DynamoDB
persistence. Workers, HTTP, and Angular UI are not implemented yet; the LocalStack harness
exercises the separate event-spine proof and direct consumer command transactions.

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

`src/shared/contracts.ts` owns strict Zod state/input/version-1 event schemas;
`src/shared/presentation.ts` shares browser-safe metadata and schemas without server
decisions. `src/domain/projections.ts` plans content/status/due-review and review history/
editor/pending membership, including explicit old-key deletions and stable sort keys.
Factories/imports do not generate IDs, start services, resolve credentials, or call AWS.

Credential-free headless composition through the consumer dispatcher:

```ts
import { createContentDispatch } from "./src/application/dispatch";
import { createMemoryPersistence } from "./src/application/memory";
import { fixtureAuth } from "./src/shared/identities";

const memory = createMemoryPersistence();
const dispatch = createContentDispatch({ persistence: memory.factory });
const result = await dispatch(
  {
    resourceType: "contentItem",
    commandName: "create",
    input: { title: "Release notes", body: "Draft release notes." },
    idempotencyKey: crypto.randomUUID(),
    requestContext: {},
  },
  fixtureAuth("author_1"),
);
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

Attachments intentionally accept only `[]` until Phase 8 adds bounded slots and verified
object references. No asset bytes, object store, scheduling commands, publication execution,
or artifact-writing protocol is implemented here. The schedule metadata shape supports
invalidation; scheduling/time-zone semantics and full publication execution state remain
Phases 10-12. Scheduled/publishing/published transition tests use trusted seeded editorial
states, not an executed publication workflow.

Core requires commands and separates create from update, so the review resource has two
internal primitives. They require `review_projector`/`reviewProjector`, preserve submitted
fields, and reject stale source versions or regressing closed outcomes. A closed snapshot
can arrive before its older requested fact without restoring pending state. Phase 9 will
add envelope/source validation, ignore/reload behavior, worker retries, and the event pump.
Public ingress must reject both internal command names regardless of headers, and fixture
selectors must never offer service identities. No HTTP ingress is exposed yet.

Tests execute public commands against memory and SDK contract persistence without Work
Request helpers, direct event publication, or a second editorial authority. The live proof
below includes consumer transactions, not deployed editorial workers or an HTTP application.

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
