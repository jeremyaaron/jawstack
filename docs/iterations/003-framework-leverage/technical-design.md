# Iteration 3 Technical Design: Framework Leverage

Status: reviewed as the basis for the [implementation plan](implementation-plan.md),
implementing the outcomes of the [reviewed PRD](prd.md).
This is a design, not shipped API documentation or implementation evidence. Exact source
organization can change during implementation, but the contracts, boundaries, compatibility
rules and acceptance obligations below require explicit review to change materially.

## Design Summary

Productize the invocation-scoped command/persistence and worker recovery protocols already
exercised by Content Operations. Keep editorial authority, publication fences, immutable
artifacts, uploads, notifications and recurring-job policy in that application.

Use the existing public packages rather than add a general orchestration package:

- `@jawstack/core`: workflow declaration, scoped dispatch, adapter-neutral commit planning,
  atomic record contributions, generic delivery/recovery decisions and memory execution.
- `@jawstack/aws-runtime`: DynamoDB compilation/storage and validated SQS worker/collector
  adapters; an explicit local-only client/binding subpath for installed consumers.
- `@jawstack/aws-cdk`: opt-in collector composition using the existing workflow construct
  and named bindings, with unchanged defaults for consumers that do not opt in.
- Private `@jawstack/local-lab` under `tooling/local-lab`: shared SDK provisioning, Docker
  lifecycle and evidence support. No application imports and no runtime dependency from
  public packages. Report Runs' installed runtime must work without this private package.
- `apps/report-runs`: one resource, one asynchronous report worker, loopback HTTP/CLI,
  no Angular, S3, Scheduler or additional artifact/lease subsystem.

All new capabilities are opt-in. Existing `executeCommand`, repositories, units of work,
SQS/Scheduler adapters, generated Work Requests behavior and CDK defaults remain supported.
`defineWorkflow` below describes resource/consumer composition, not workflow steps or a DAG.

## Decisions

| Topic                   | Decision                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public package count    | Keep the current public packages; add backend exports in their existing ownership boundaries.                                                               |
| Command execution       | Compose the existing core executor; do not implement a second command validator/fingerprint/decision engine.                                                |
| Contribution vocabulary | Registered create-only typed records plus existing projection writes; no arbitrary SDK operations, cross-resource state writes or user-supplied conditions. |
| Atomicity               | One normalized logical plan drives memory and DynamoDB; domain record planning runs before any write.                                                       |
| Recovery authority      | The framework owns delivery history and replay authorization records; the application owns business eligibility, completion and reconciliation.             |
| Publication             | Preserve Content Operations' authoritative state and explicit editor retry; publisher-envelope replay stays forbidden.                                      |
| Storage/wire migration  | Preserve current Content Operations keys, envelope normalization, fingerprints and DTOs using golden compatibility fixtures. No silent reset or adoption.   |
| Runtime lifetime        | Explicit construction/start/close. Imports declare factories only; no timers, clients, credential lookup or network requests.                               |
| Lab                     | Extract bounded existing providers, not a new infrastructure DSL; report profiles omit unused services.                                                     |
| Real deployment         | CDK synthesis plus SDK-provisioned local execution remain separate. No real-AWS deployment or production-auth claim.                                        |
| Measurement             | Freeze code inventories and two paired change specifications before extraction; use fresh user-mediated agent sessions and retain negative results.         |

## Package and File Ownership

The names below are implementation targets, not promises that these files already exist.
New implementation modules must be cohesive; avoid adding another large `index.ts` body.

```text
packages/core/src/
  workflow/
    definition.ts          # declaration validation and immutable manifest
    command-runtime.ts     # scoped invocation and bounded replay lookup
    records.ts             # registered record definitions/contributions
    commit-plan.ts         # logical keys, normalization, limits, conditions
    events.ts              # strict envelope/recovery normalization
    operations.ts          # collection/replay state machine and summaries
    delivery.ts            # validate -> authorize -> handle -> complete
    memory.ts              # shared store, atomic commits, bounded pump
packages/aws-runtime/src/
  workflow/                # DynamoDB store/compiler and SQS binding
  local.ts                 # explicit opt-in local binding/client factories
packages/aws-cdk/src/
  recovery.ts              # opt-in collector construction and bindings
tooling/local-lab/src/
  profile.ts               # finite resource inventory and validation
  clients.ts               # management clients using shared local transport guard
  provision.ts             # existing supported service providers
  ownership.ts             # manifest, tags, mappings, sentinels
  containers.ts            # exact-owner runtime cleanup
  lifecycle.ts             # up/provision/reset/down and evidence
apps/report-runs/src/
  contracts.ts             # request/result schemas and canonical rendering
  resource.ts              # request and internal completion commands
  workflow.ts              # declarations and domain consumer binding
  runtime.ts               # explicit memory/local composition
  http.ts                  # bounded loopback routes and fixture resolution
  cli.ts                   # thin commands using the HTTP API
  aws.ts                   # thin bundled worker/collector entrypoints
  lab-profile.ts           # app names, assets, bounds; no SDK provisioning code
```

Public imports remain package exports. `@jawstack/aws-runtime/local` is a new, intentional
subpath with compiled JS and declaration exports, not permission to deep-import `src`.
Source aliases used by workspace unit tests must cover that public subpath explicitly;
installed-consumer and bundle checks must use compiled exports without those aliases.

Core's adapter-neutral runtime/store contract must also be available through supported
backend exports for the AWS package. The logical plan is internal to framework execution,
not private to one package: adapters may consume validated framework-produced plans, but
applications cannot submit raw writes/conditions or construct arbitrary transaction plans.
Keep that adapter-author surface minimal, separate from the normal application recipe,
and include it in the public export/concept growth measurement. Do not solve this boundary
with deep imports or a second planner in the AWS package.

Add `tooling/*` to the workspace and relevant root build/typecheck/test/lint filters. The
private lab package has credential-free unit tests; integration is never default test
discovery. Public package dependencies may not point to it. No new dependency is needed
merely for JSON reports or the leverage counter; use existing Zod/TypeScript/Node facilities.

## Public Composition Contract

### Definition Versus Binding

`defineWorkflow` validates a single declaration containing:

- Stable workflow name, explicit event source and the existing resource definitions.
- Explicit command policy, typed record definitions and pure commit contributions.
- Event schemas, versions and application-specific payload-to-resource identity checks.
- Consumer entries keyed by already-declared `defineWorker` names, recovery policy and
  bounded delivery settings. Subscription lists come from the existing resource workers.
- The resource/projection namespace used for operational summaries.

The declaration returns an immutable backend definition and a function-free manifest.
The manifest is a projection of the declaration, not a separately edited configuration.
It drives transport bindings, CDK comparison, local inventory and diagnostics. Resource
decisions and schemas remain normal TypeScript/Zod, not a new domain language.

Manifest fields are names, declared event/schema versions, subscriptions, record collections,
selected policies and numeric bounds. Do not serialize Zod instances or function bodies.
Its hash detects configuration mismatch, not equivalent code; separately recorded ZIP
digests identify the deployed implementation. Neither hash is an authentication secret.
Managed consumers share one delivery-bound profile in this iteration; mixed timeout/
receive/visibility profiles fail validation instead of creating another override system.

Factories receive a separate synchronous `bind(services)` callback. It constructs the
application's domain handlers and returns the exact configured consumer names with their
`handle`, optional `reconcileFailure`, and optional `authorizeReplay` functions. Runtime
services are constructed before binding; dispatch/delivery during binding is rejected.
Bindings must not perform startup I/O. Missing, extra, inherited or duplicate names fail
before the server starts or any infrastructure is provisioned.

This avoids mutable global runtime references and factory cycles. Content Operations can
construct its publisher, notification sink and materializers using provided dispatch/read
services and its own object/job services, without the framework constructing those services.

### Factories and Surface

| Package              | Proposed export                                     | Responsibility                                                                                                        |
| -------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Core                 | `defineAtomicRecord`                                | Typed, owned, create-only record declaration and branded contribution constructor.                                    |
| Core                 | `defineWorkflow`                                    | Validated resource/event/consumer/policy declaration and manifest.                                                    |
| Core                 | `createMemoryWorkflow`                              | Scoped command services, records, recovery, delivery and explicit memory pumping.                                     |
| AWS runtime          | `createDynamoWorkflow`                              | The same service contract backed by an explicitly supplied client/table.                                              |
| AWS runtime          | `createWorkflowSqsHandlers`                         | One binding returning worker/collector handlers for an exact consumer and its fixed source/DLQ ARNs.                  |
| AWS runtime `/local` | `parseLocalWorkflowBindings`, `createLocalWorkflow` | Bounded routing-data validation, guarded local clients, ownership checks and Dynamo workflow construction.            |
| AWS runtime `/local` | `createLocalAwsTransport`                           | Shared explicit dummy-credential/final-destination policy for lab management clients; not a cloud credential factory. |

Both workflow factories expose `dispatch`, `repository`, `queries`, `records`, `operations`,
`events`, `delivery` and `close`. Memory additionally exposes `drain`, `drainUntilIdle`,
`start` and its backing memory store for existing domain-specific stores. AWS execution
does not expose a host pump or silently substitute host worker calls.

`dispatch(request, resolvedAuth)` retains `CommandExecutionResult<T>` and normal core
metadata. Ingress still resolves/authenticates identity and allowlists commands. `records`
is a backend read service for registered record definitions, not a new public HTTP database
endpoint. `operations` requires application authorization for inspection/replay and never
returns its private original envelope through those APIs.

Methods under `delivery` are framework transport entrypoints, not user HTTP routes. Only
the memory driver or validated AWS adapter invokes them. Handler failures throw for transport
retry; command calls retain structured result envelopes. Unknown dependencies and invalid
configuration fail explicitly, not through no-op handlers or empty successful pages.

### Minimal Application Shape

The following illustrates the selected responsibilities; omitted business definitions are
application code, not future framework magic or a complete copy/paste implementation.

```ts
const definition = defineWorkflow({
  name: "report-runs",
  source: eventSource,
  resources: [reportRun],
  commands: { idempotencyTtlSeconds: 604800, maxActions: 60 },
  records: [],
  events: reportEventDefinitions,
  consumers: { buildInventory: { recovery: "replay", ...deliveryBounds } },
  operations: { resourceType: "reportRun", projection: "reportRun.failures" },
});

const runtime = createMemoryWorkflow(definition, {
  clock,
  authorizeOperations,
  bind: (services) => ({
    buildInventory: {
      handle: createInventoryHandler(services),
      reconcileFailure: reconcileReportFailure(services),
      authorizeReplay: requireUnfinishedReport(services),
    },
  }),
});
```

The Dynamo/local variants change storage/client construction, not report handlers or
delivery/recovery algorithms. Existing `defineResource`/`defineWorker` declarations remain
the source of command behavior and subscriptions; registration must not repeat event lists.

## Scoped Command Execution

### Invocation State

The runtime validates and snapshots the request and resolved auth, discards untrusted
`requestContext` before passing the invocation to application hooks, and captures one
server instant. Claims stay private and are never included in storage keys or diagnostics.
Scope is `{ resourceType, commandName, subject }` within one workflow-owned table/store.
Tenant-scoped auth/events are rejected by this new capability in this iteration; do not
imply tenant isolation by omitting tenant ID from keys. Legacy APIs are unchanged.
Reject tenant-bearing stored resource/idempotency data as well rather than adopting it
into a single-workspace runtime under an unscoped caller.

Scope/key components use the current bounded ASCII alphabet and 1-200 character limit.
Resource/event identity schemas can be narrower in a consumer. One workflow owns a table
or memory store; mounting unrelated workflow definitions over the same storage is rejected
by composition/ownership checks rather than relying on name prefixes for isolation.

Use `executeCommand` for resource lookup, server role checks, schema parsing, domain
decisions, fingerprints, activity/event creation and result envelopes. A per-invocation
repository/unit-of-work pair captures immutable scope/time. There is no shared mutable
"current request" field on a repository, and no second implementation of core decisions.

For all scoped capability commands, idempotency is mandatory. The existing core fingerprint
uses validated input, resource type, command and caller-supplied target ID. Creation without
a target matches its first stored response; explicit targets participate in matching.
Preserve the existing fingerprint encoding rather than introduce a new hash format during
extraction. Schema transformations determine equivalent intent and must be tested.

### Expiry and Ambiguous Commit Resolution

Both apps explicitly configure seven-day command expiry. Expiry uses the captured instant
and integer epoch seconds. A record with `expiresAt <= nowSeconds` is logically absent.
Dynamo replacement uses one conditional put: absent key OR expired existing row. A live
competing row is never overwritten. Memory checks that same condition under its commit lock.
TTL deletion timing is not part of correctness; legacy unscoped TTL behavior stays unchanged.

After an eligible conflict/unavailable result, perform at most four strong scoped lookups
at 0/10/25/50 ms pauses. If a live record appears, re-enter only the core executor's ordinary
authorization/input/fingerprint/replay path with that record pinned. State reads and commit
are disabled for this replay. No record means return the original error; never rerun a stale
mutation decision. SDK retries remain bounded separately and use the already-built plan.

Corrupt records are errors, not cache misses. Equivalent response replay preserves original
response metadata. A conflict caused by different intent remains an idempotency conflict.
Each invocation's IDs/time are fixed; lookups must not create events or new record identities.

### Result Validation Hook

Factory option `validateResult` runs after ordinary execution or replay and may reject a
success by throwing a structured runtime error. It cannot rewrite the committed response,
perform another commit through this hook, or turn an error into success. It receives the
captured request, result, read services and a live-clock accessor.

Content Operations adapts its existing claim-response validator here: a stored successful
claim whose lease has expired, completed or been superseded cannot be returned as usable
authority. The generic runtime knows nothing about publications/fencing. Golden tests must
preserve the current outward error/metadata behavior for all claim replay paths.

## Atomic Record Contributions

### Registered Records

`defineAtomicRecord<T>` accepts a unique bounded collection name, strict schema, a pure
logical-key function and an owner function returning `{ resourceType, resourceId }`.
`record.create(value)` yields a branded contribution referencing that registered definition.
It does not write. The planner revalidates registration, schema, key and ownership at runtime;
TypeScript casts cannot bypass those checks.

Collection names cannot use framework-reserved namespaces. Values must be finite JSON:
no dates, functions, prototypes, binary buffers, nonfinite numbers or undefined fields.
Reserved storage fields such as `PK`, `SK` and `itemKind` cannot be supplied as data.
Each logical key is nonempty, valid UTF-8 and at most 1,024 bytes. The owner must match
the command's authoritative resource; a contribution cannot mutate another resource.

This iteration supports create-only auxiliary records. Corrections are new immutable
records, not arbitrary updates/deletes or caller-authored conditional expressions. Generic
failure-history CAS is a separate framework-owned store, not an exposed escape hatch.

`contribute({ invocation, commit })` is synchronous and deterministic, returning registered
record creates and additional `ProjectionWrite`s. It sees a detached readonly successful
core commit with assigned IDs/time, not clients or mutable storage. Reject Promise results;
side effects and live reads in contributions are outside the contract. A contribution
failure occurs before writing anything and is covered by mutation/rollback regressions.

Content Operations contributes its command receipt and `publicationOperations(...)` results.
Its validation that an attempt fact matches a permitted publication transition stays in
the application. The framework stores those records and normalizes their query projections.
Report Runs needs no automatic command-receipt record simply to use scoped persistence.

### Logical Plan and Limits

The internal plan contains primary state with an expected-version/create condition,
immutable activity/outbox writes, normalized projection puts/deletes, scoped idempotency
replacement and registered auxiliary creates. It is not an exported arbitrary write API.
Activity/outbox/auxiliary creates require absent physical keys, including against records
already stored, not only duplicates inside the plan. Add these conditions in the new
compiler without silently changing legacy builder defaults.

Process the plan in this order:

1. Validate resource/scope/actor/time and successful core input; validate contributions.
2. Resolve every physical identity with pure shared key functions.
3. Coalesce identical projection puts and compatible delete/put pairs for the exact same
   key, with put winning as in the current consumer. Reject conflicting puts and every
   other duplicate physical action, including collisions across record kinds.
4. Check JSON/key/record/action budgets before storage mutation or SDK calls.
5. Apply all conditions and write one atomic commit, or publish nothing.

Use 60 actions by default and as this capability's hard maximum for the iteration. Bound
each logical stored record to 192 KiB, the complete normalized plan to 1 MiB canonical JSON,
JSON depth to 16 and total JSON nodes to 10,000. Auxiliary records are at most 64 KiB each.
These are conservative capability limits, not changes to existing domain byte bounds.
Current Content Operations fixtures must demonstrate they fit before migration proceeds.

The Dynamo compiler additionally validates the complete marshalled request against service
size limits before send; the logical limits and encoding tests must make this a defensive
compiler check, not a routine difference from memory acceptance. Do not split an oversized
command into non-atomic writes. DynamoDB supports at most 100 transaction actions/4 MB and
forbids multiple actions on one item; these are upper bounds, not reasons to loosen the
selected capability limits. [AWS transaction semantics](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html).

### Memory and DynamoDB Implementations

Memory retains one store for primary/activity/projection/outbox records plus scoped
idempotency, registered auxiliary rows and framework operations. It uses a serialized
commit lock. Stage/clone/validate everything before publishing; after acquiring the lock,
condition checking and final publication perform no asynchronous work. Any error leaves
every collection unchanged. Returned rows and plans are detached copies.

Keep the backing `InMemoryStore` available to existing application-owned notification/job
stores during migration. Their domain commits must remain non-yielding; no generic command
planner may clone stale projections across an await and overwrite a concurrent domain-store
commit. The shared key resolver must preserve the current exact-sort behavior, not call
the legacy memory unit of work's broader item-prefix projection deletion algorithm.

Dynamo compiles the same plan into a single `TransactWriteItems`. Capture action indexes
and condition roles for deterministic error translation. Scoped idempotency condition
failure becomes `idempotency.conflict`; other known condition failures become
`resource.conflict`; transport/ambiguous service failures become `runtime.unavailable`.
Malformed stored state becomes `resource.invalid_state`. No raw SDK response is returned.
Strong reads use the configured owned table; no scan or ambient table/client selection.

Existing public key/item/transaction builders stay compatible. Extract common pure key
logic into core's internal workflow modules and delegate from AWS builders where useful;
memory must not import AWS SDK transaction shapes. Legacy persistence retains its current
semantics unless an independently reviewed fix is necessary.

## Worker Definition and Delivery

### Event Registry

Each workflow has an event registry with strict payload schemas, declared versions and
application-provided target-identity validation. Managed payloads are JSON objects;
`payload.delivery` is reserved for framework recovery metadata. Ordinary command facts
cannot supply that reserved field. Legacy unmanaged core events are unaffected.

The framework owns base envelope validation/canonicalization and recovery metadata.
Applications validate domain payloads and whether their resource IDs match the fact.
Bound source/type IDs, actor/correlation/causation, timestamp syntax and encoded bytes.
No tenant envelopes are accepted by the selected capability. Preserve Content Operations'
80 KiB payload bound and canonical version-1 wire ordering; Report Runs selects 32 KiB.

Validate plain envelopes and EventBridge-wrapped deliveries. Outer source/detail-type, when
present, must match the inner fact. Validate every bounded SQS batch before any marker lookup
or business effect. Queue ARN is an exact binding from trusted function composition, never
an endpoint/consumer selected by message input. Batch size remains one for both app profiles;
the adapter accepts at most ten only when explicitly configured, with whole-batch retry.

### Delivery Order

1. Validate transport, all envelopes, schema versions, source/identity and subscriptions.
2. Authorize any targeted recovery against its durable record, even if a marker exists.
3. For a targeted fact, non-target subscribers acknowledge only an authenticated ignored
   fan-out copy; they never execute its business effect.
4. Consult the selected consumer's processed marker, then invoke the bound domain handler.
5. For targeted recovery, mark the matching recovery generation resolved durably.
6. Write a successful processing marker only after those steps complete; return normally.

The new AWS wrapper can reuse `SqsWorkerAdapter` internally after prevalidation and
authorization, but its legacy early marker shortcut must not bypass steps 1-2. The
legacy adapter's public behavior does not change. An explicit ignored business outcome
may be acknowledged only after ordinary validation, never as an unknown-handler fallback.

Concurrent deliveries may run a domain handler more than once before a marker exists.
Markers do not provide a distributed lock or exactly-once side effects. Domain source
versions, immutable identity, optimistic commands and conditional object effects retain
their existing obligations. A crash after domain completion but before marking must be
safe to retry through those business guards.

### Memory Driver

Extract the existing bounded pump: serialize drains; admit an entire event fan-out before
advancing its cursor; retain terminal/deferred work; detect outbox reset and changed content
at a reused transport ID; backpressure rather than evict pending work.

Defaults remain 200 pending/terminal jobs, 1,000 delivery markers, 1,000 collection markers,
50 events/handler attempts per pass, and seven-day markers. Capacities are 1-10,000; per-pass
limit is 1-100. Three attempts use injected-clock cutoffs +1/+2 seconds; collector deferral
retries after one second. Draining never advances time. `drainUntilIdle` defaults to twenty
passes, maximum one hundred, and reports deferred work rather than inventing success.

`start({ intervalMs: 1000 })` is an explicit serialized driver with bounded stop/abort; it
is never called by import or runtime construction. Content Operations may instead retain
its single HTTP-managed loop calling `drain` alongside its separate job cadence. Do not
start two pumps or move recurring-job policy into the shared driver. Report's launcher
uses the managed driver; AWS mode cannot start it.

## Durable Failure and Recovery Protocol

### Records and Queries

Retain the existing bounded record model:

```ts
type FailureRecord = {
  id: string;
  version: number;
  consumer: string;
  original: JawStackEvent;
  fingerprint: string;
  firstCollectedAt: string;
  collections: CollectionStage[]; // original plus up to three recovery deliveries
  recoveries: RecoveryRequest[]; // at most three operator requests
  resolvedGeneration: number | null;
};
```

Failure ID is SHA-256 of the JSON tuple `[consumer, originalEventId]`, within a workflow-owned
table/store. The fingerprint is over the canonical original wire envelope. Original payload,
consumer, first instant and fingerprint never change. Recovery requests append, collection
resolution advances monotonically, and history cannot be rewritten or truncated.

Collection resolutions remain `pending`, `notApplicable`, `stalled`, `failed`, `superseded`,
and `succeeded`. Summaries retain `reconciling`, `failed`, `replayQueued`, or `resolved` plus
bounded history and trace references. No payload, credentials, storage keys, exception stack
or publication token appears in inspection. Store failures have no TTL; default memory
capacity is 1,000 records, bounded override up to 10,000, with rejection rather than eviction.
Maximum encoded failure row is 128 KiB.

Pages default to fifty and allow at most one hundred, using the existing keyset query
contract. Original events remain private. Application HTTP filters retain their existing
candidate/cursor budgets and authorization. Framework query calls cannot accept arbitrary
table/partition selectors. Consumer identity must be registered even when reading old data.

### Collection State Machine

```text
validate and authorize source/recovery
  -> CAS-create/append pending collection stage
  -> application reconciliation hook
  -> CAS-complete that stage
  -> collector marker / source acknowledgement
```

The hook returns one terminal resolution from the enum above, excluding `pending`, or
throws for retry/deferral. `succeeded`/`superseded` resolve that delivery generation;
other completed resolutions remain inspectable failures. When no reconciliation hook is
bound, resolution defaults to `notApplicable`; a throwing hook never takes that shortcut.
Invalid traffic is unacknowledged, not persisted as a manufactured business failure.

Persist before calling the hook. Retry a pending stage after interruption; never run a
non-repeatable reconciliation callback. Preserve three bounded strong-read/CAS attempts
for internal row updates. Concurrent collection, replay and completion cannot regress a
resolved generation or replace a newer record. Source acknowledgement follows durable
reconciliation, including when the original effect had already succeeded.

Hooks read/modify business state through ordinary authorized application services; they
cannot mutate the framework ledger directly. Their business transactions and the ledger
are not one cross-resource transaction. Therefore hooks must be idempotent, strongly
reread current authority, and use expected versions/fences where required. The framework
must not claim atomic business reconciliation merely because its own CAS succeeded.

### Recovery Requests

`operations.inspect(auth, query)` and `operations.replay(id, auth, requestId)` require a
configured application authorizer; absent authorizers deny access. Request IDs are UUIDs.
The actor is derived from resolved auth, never a request-body role or actor field.
The authorizer receives the action and bounded query/summary, not permission to supply
replacement events. An optional consumer eligibility hook adds domain restrictions; its
absence under explicit `replay` policy imposes no additional domain rule, but never bypasses
the mandatory operator, durable-history and envelope checks.

Replay requires a collected/reconciled unresolved latest generation, a registered consumer
with policy `replay`, application eligibility, and a remaining recovery budget. Policy
`application` permits collection/inspection but forbids generic envelope replay. Unknown
policies/names or errors deny recovery. Content Operations assigns `application` to its
publisher and `replay` to the other three consumers.

For an equivalent request ID return the original history; an already-queued cycle cannot
consume another generation. Create new transport UUID/time while preserving original
business payload, actor, correlation, and original-event identity. Causation points at the
original event. Put the four-field metadata under `payload.delivery`:

```ts
{
  (originalEventId, generation, consumer, failureId);
}
```

Commit failure history/projection and a create-only normal outbox event together. Never
send directly to SQS or `PutEvents` from the recovery service. On an ambiguous transaction
result, strong-read by failure/request ID to converge before returning a retryable error.
Retries cannot invent a second event or business request. A recovered delivery must match
the stored replay envelope exactly before it can consult a marker or invoke a handler.

Eligibility hooks are advisory until the business effect rechecks current authority:
completion may race a recovery request. A benign redundant replay may be recorded, but
its handler must observe completed/superseded state and not repeat the logical effect.
No lock spanning application code and the recovery store is introduced.

### Content Operations Reconciliation Boundary

Move generic record/update/replay machinery out; retain a small publication reconciler
that loads content, validates frozen intent, compares publication/generation/source event,
defers live claims, and issues `reconcilePublicationFailure` under its dedicated identity.
Its late-success/newer-generation checks and the editor `retryPublication` command remain.
The framework does not create leases, close publication attempts, unlock editing or infer
publication success from a worker marker or S3 object.

Keep editor inspection/replay authorization and public DTO conversion in the app. Browser
schemas remain browser-safe; do not import the backend core runtime into shared UI modules
merely to reuse operational types. Use type-only imports and app DTO validation where
needed. Domain schema/translation code is not duplicate recovery protocol implementation.

## Storage and Compatibility

Use dedicated tables/stores per workflow and the current key encoding; no table migration
is needed for the selected generic protocols. Registered collection names and operational
projection ownership are explicit configuration, not editorial constants in packages.

| Record                  | Content Operations format to preserve                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Primary/activity/outbox | Existing public `RES#...`, `ACT#...`, `OUTBOX#...` key and item encodings.                                               |
| Scoped command          | `PK=IDEMP#<resourceType>#<commandName>#<subject>`, `SK=<key>`; existing fingerprint, response and integer expiry fields. |
| Command receipt         | `PK=OPS#commandReceipt`, `SK=<resourceType>#<resourceId>#<version>`, `itemKind=APP_OPERATION`.                           |
| Publication attempt     | `PK=OPS#publicationAttempt`, existing content/publication/attempt/stage sort key and `APP_OPERATION` shape.              |
| Failed delivery         | `PK=FAILURE#<hash>`, `SK=DELIVERY`, `itemKind=APP_FAILURE`, existing version/history fields.                             |
| Failure projection      | Existing `contentItem.failures` partition/sort and public summary shape.                                                 |
| Processing markers      | Existing consumer name and `collectFailure.<consumer>` names with seven-day TTL.                                         |
| Recovery wire           | Current canonical envelope order and four-field `payload.delivery`; original identity/fingerprint remains stable.        |

The generic implementation can use these neutral storage families for Report Runs too;
its operational projection is `reportRun.failures`. Framework packages must contain no
`contentItem`, publication command names, fixture editor IDs or hard-coded app queue names.

Freeze golden rows/envelopes before extraction, including each failure stage, idempotency
response, projection alias/suffix and marker name. Assert both directions: legacy fixtures
read under the new runtime, and new writes match the old app contract where applicable.
Missing kind/key/consumer/version or mismatched fingerprints remain explicit errors.

Content's legacy two-field delivery metadata remains parse-compatible only under its
explicit legacy compatibility setting for existing trusted business fixtures. It cannot
authorize a new durable recovery, pass the collector as a recorded replay, or be emitted
by the new recovery service. Report Runs accepts only original facts or recorded four-field
recoveries. Keep that exception tested and out of the default recipe.

No automatic reset, dual-write migration, fallback protocol copy or adoption of unknown
records. If a discovered format cannot be preserved, stop for a reviewed migration decision
and a disposable export/import/reset test. Existing interactive processes are not restarted
to make the new code appear compatible; tests use separate instances.

## AWS and CDK Composition

`createDynamoWorkflow` accepts explicit clients/table and constructs no credential provider.
Its failure store uses one conditional transaction for failure row, projection and optional
replay outbox; it validates old/new history before compilation. It shares key/record validators
and bounded CAS rules with memory. Delivery markers remain the existing AWS marker adapter.

`createWorkflowSqsHandlers({ runtime, consumer, sourceQueueArn, deadLetterQueueArn })`
returns worker/collector handlers for that exact binding. App Lambda entrypoints construct
an owned runtime lazily and delegate; they do not switch on consumer names or duplicate
source/recovery/marker logic. There is no generic user-supplied worker-dispatch HTTP route.

Add optional `recoverableWorkers` to `JawStackResourceWorkflowApp` containing the workflow
definition and collector archive entrypoint. Existing resources/worker handlers remain
the construct's base inputs; validate their names/subscriptions against the definition
rather than silently accepting two sources of truth. Existing named worker bindings supply
the DLQs. Expose additive readonly `collectorFunctionsByName`; it is empty without opt-in.

One collector per selected worker uses the same bounded timeout/memory/concurrency profile,
its matching DLQ, table permissions and explicit log retention. Do not add a collector-DLQ
chain. Normal application workers retain only their declared domain grants. Named function
bindings continue to support publication S3/job permissions in Content Operations.

Profiles retain timeout 30 s, memory 256 MiB, concurrency two, batch one, source and collector
visibility 180 s, max receives three, source retention four days, DLQ retention fourteen days,
and logs seven days. This is the bounded existing local acceptance profile, not a production
tuning recommendation. It deliberately retains three receives although AWS recommends at
least five; do not misrepresent local bounds as universal AWS best practice. Visibility
remains at least six function timeouts. [AWS SQS/Lambda configuration](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html).

When `recoverableWorkers` is absent, preserve old resources, policies, defaults and logical
IDs. When opting in Content Operations, reuse the collector construct IDs/names already in
its composition where possible and assert normalized template parity. Add the necessary
owned-table metadata-read permissions for explicit local startup checks; synthesis is not
live IAM enforcement proof. Never inspect construct-tree children to implement the feature.

## Shared Local Lab

### Public Local Runtime Boundary

The `/local` subpath accepts a versioned, bounded `LocalWorkflowBindings` value containing
workflow/profile hash, lab/owner identity, dummy account/region, table/bus, exact function
roles and source/DLQ ARNs. Optional service bindings exist only for the configured profile.
It contains no token, real credentials, arbitrary endpoint override or code paths to execute.

`parseLocalWorkflowBindings` is pure. `createLocalWorkflow` requires explicit `host` or
`lambda` execution context, checks workflow/profile/function identity, rejects inherited
unsafe AWS settings, constructs dummy-credential clients with a final HTTP destination
guard, and checks expected table ownership before returning a Dynamo workflow. Lambda
context must match the declared exact function/role/consumer; message fields cannot choose it.
Host targets only `http://127.0.0.1:4566`; Lambda only `http://localstack:4566` on the owned
network. Keep finite SDK attempts/timeouts and no region/credential/endpoint fallback.

The private lab writes a sanitized binding file after successful provision and places the
appropriate bounded binding metadata in each owned Lambda. Host launchers read the explicitly
selected file and call the public parser/factory; Lambda wrappers read explicitly declared
metadata only when invoked. Missing/structurally unsafe metadata and inherited real-AWS
settings fail before client requests. Structurally valid bindings still require guarded
local ownership reads before business access. Bound the binding document to 64 KiB;
file/env contents are never printed. Clients close on failure and controlled shutdown.

Content Operations' object-store/cleanup services use the same exported local transport
policy while keeping their S3 identity/immutability/permission rules in the app. Private lab
management clients use that policy too. An installed Report Runs memory or AWS bundle must
not import `@jawstack/local-lab` merely to obtain safe client construction.

### Finite Profile and Lifecycle

The private lab accepts data profiles with exact names, resource inventory, immutable ZIP
paths/digests, expected tags, subscriptions, bounds and optional existing S3/Scheduler roles.
It derives managed worker/collector entries from the workflow manifest. App-specific jobs,
proof functions, bucket grants and schedules remain profile data, not callbacks that issue
SDK mutations or arbitrary shell commands.

Reuse/extract providers for DynamoDB/stream, bus/rules, SQS/mappings, Lambda assets/roles/logs
and the existing S3/Scheduler subset needed by Content Operations. Do not add new service
providers for Report Runs. The finite profile is repository tooling, not a public cloud DSL.
Separate pure validation/planning from explicit client/provision/lifecycle operations.

The shared implementation owns endpoint guards, manifests, pre-existing-resource refusal,
tag/mapping preflight, bounded pagination/readiness, sentinel reset, exact-ID runtime cleanup
and final teardown evidence. Preserve running/exited/removing-runtime behavior and foreign
lookalike refusal. Destruction requires manifest ownership plus current service/container
proof; a prefix or profile declaration alone never authorizes deletion.

Profiles do not mutate their live lab after hashing. An asset/profile change requires
explicit owned reprovision/reset, not silent adoption. Record schema/profile versions and
retain the manifest on unproven cleanup. Imported profile modules must not read dotenv or
create clients. Only explicit `up` loads/passes the token to the emulator; inspection,
provision, reset and down use dummy clients and do not need it. Record user Hobby attestation
and its instant in the manifest without persisting the token. CI preflight may check its
explicit secret before startup, never expose it to worker/browser processes.

Support a compatibility decoder for current Content Operations manifests for owned down
only, reusing the same lifecycle algorithm and exact known legacy profile. Do not overwrite
or upgrade a running legacy lab in place. Unsupported/unprovable manifests remain refused;
cleanup must be resolved before provisioning a new version. Acceptance always uses fresh
versioned manifests, not deletion of an old manifest to bypass ownership proof.

Use the existing pinned image/digest from Iteration 2 and user-attested Hobby setting.
Do not renegotiate licensing, activate trials, mount real credential directories or expand
the service matrix during extraction. Docker socket privilege and emulator limitations stay
documented. Preserve the Content Operations token path through its thin launcher; Report
Runs accepts an explicitly selected ignored env-file path or CI startup environment, never
searches another app/home directory for a token or copies it into the repository.

Use separate workflow/lab/project identities. Content names keep their existing layout;
Report Runs uses `jawstack-report-runs-<lab>`. Host port 4566 allows only one owned emulator
at a time. Run consumers' full gates sequentially, with owned teardown between them, and
never reuse a different app's live manifest or dataset.

The CDK template and SDK lab consume the same managed worker subscriptions/bounds, but keep
the documented differences in ingress, sweeper, schedule grouping, physical names and proof
functions. Report's lab provisions one table/stream, one bus, one source queue/DLQ, dispatcher,
report worker and collector, with necessary roles/mappings/logs. No bucket or schedule is
provisioned for it. Report CDK synthesis may retain the base construct's HTTP API/sweeper;
those are explicitly not an assertion that the SDK lab deployed them.

## Report Runs

### Request and Stored Result

One resource, `reportRun`, has `requested` and `completed` business states. Requests are
immutable; no edit/cancel/reschedule feature is introduced. State contains report ID,
requester, request time, canonical input/digest and, only after completion, result/digest
and completion time. Runtime failure/recovery history lives in the framework ledger.

Strict input is `{ items: [{ itemId, label, quantity }] }` with 1-100 unique case-sensitive
ASCII IDs (1-64 letters/digits/`_.:-`), trimmed NFC labels (1-160 UTF-8 bytes, valid Unicode,
no controls), and integer quantities 0-1,000,000. Sort by item ID's UTF-8 order during schema
normalization. Reject unknown fields, duplicates and unsafe/nonfinite/coerced values.
The normalized input is at most 16 KiB; the bounded HTTP JSON envelope allows 20 KiB for
input, command key and encoding overhead. Total quantity is at most
100,000,000 and remains a safe integer. Validate the predicted result's 32 KiB bound before
committing a request; validation computes no durable result or fake worker success.

Canonical output has version 1, report ID, original request time, sorted normalized items
and `{ itemCount, totalQuantity, zeroStockCount }`. Use explicit stable property order and
one trailing LF for export, SHA-256 over UTF-8 bytes, no completion time or current wall
clock inside those bytes. Store the structured result and digest in resource state; the
HTTP export verifies/serializes that stored result, not an uncommitted reconstruction.

### Commands and Worker

`request` is a normal create command for `requester` or `operator`. It freezes normalized
input and emits `reportRun.requested` with report ID and input digest, not a second copy
of mutable input. `complete` is an internal command available only to the registered report
worker identity; it requires expected version and exact request/digest, validates deterministic
result/digest and commits completed state, activity and `reportRun.completed` atomically.
Use existing scalar state metadata for fields such as status/requester; the app's strict
domain schema validates nested input/result JSON as Content Operations already does.
Do not add a new nested-field/UI metadata language for this headless consumer.

`buildInventory` strongly loads the requested report, verifies its event identity/digest,
calculates the bounded report and dispatches completion with a stable intent key derived
from report ID/input digest. If another delivery already completed matching output, return
read-only success. A conflicting completion re-reads through normal scoped replay/transport
retry rather than rerunning a stale state mutation. Mismatched completed data is an error.

Domain completion remains permanent after transport/command markers expire. Crash after
commit but before acknowledgement must leave one result, one completion transition and
one completed fact, even if the worker runs again. No generic task claim or artifact lease
is necessary for this small deterministic calculation.

The report reconciler returns `succeeded` for matching completed authority and otherwise
`notApplicable`. Operator replay is denied for a completed or mismatched request. Business
state always wins when showing completion; the ledger cannot turn a completed report into
a failed report. A pending report with failed delivery remains an unfinished request with
an inspectable delivery failure, not a second resource lifecycle invented by the framework.

### HTTP, CLI and Launchers

Use loopback API 4347 by default; isolated acceptance uses 4647 and fails if occupied. Memory
and LocalStack modes are explicit, never auto-detected. Use the same bounded header/origin,
UTF-8, body-deadline and structured error principles as Content Operations, through existing
public HTTP facilities where sufficient; do not copy its large upload/web router.

| Route                             | Purpose                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `GET /api/health`                 | Explicit runtime and managed/external-worker processing mode.                |
| `POST /api/reports`               | Strict inventory input/idempotency key under a resolved fixture identity.    |
| `GET /api/reports/:id`            | Authoritative request/completion plus trace and bounded delivery references. |
| `GET /api/reports/:id/result`     | Verified stored JSON bytes/digest; conflict while unfinished.                |
| `GET /api/operations`             | Operator-only bounded failure summaries, including consumer/report filters.  |
| `POST /api/operations/:id/replay` | Operator-only strict stable recovery request UUID; no replacement event.     |

The request body is `{ input: { items }, idempotencyKey }`; caller, result and report ID
cannot be supplied as input. Return HTTP 200 and the same core success envelope for a
new request or its replay, without adding a replay side channel. Public error statuses
are 400 invalid input, 403 forbidden, 404 missing, 409 conflict/not-complete, 413 oversized,
415 unsupported JSON media type and 503 dependency failure; include bounded trace IDs,
never raw SDK details. Keep UTF-8 JSON, a thirty-second body deadline, private/no-store
responses, exact loopback Host/Origin validation, finite admission, and graceful abort/close.

Provide thin CLI `request`, `status`, `result`, `failures` and `replay` commands against the
running API, with machine-readable JSON and nonzero failures. `result` writes the actual
stored JSON to stdout; any file-output option must require an explicit path and refuse
overwrite unless explicitly requested. Unknown flags/identities/modes are errors.

Fixtures are `requester_1`, `requester_2`, `operator_1`; the internal worker is not selectable
through a header or public route. Requesters inspect only their own reports/results;
operators can inspect all and recover eligible failures. These are development fixtures,
not production authentication. Seeding uses ordinary commands, explicit confirmation and
non-overwriting fixed fixture IDs. No user-selectable delay/fault/code-execution endpoint.

Proposed script names are `dev:api`, `dev:api:local`, `cli`, `seed`, `local:up`,
`local:provision`, `local:down` and `verify:local`. Launchers delegate shared machinery;
they do not contain provider algorithms, transport parsing, a custom pump or replay store.

## Migration Boundaries

| Current Content Operations area                      | Framework replacement                                 | Application code retained                                                                |
| ---------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Scoped dispatcher and both persistence adapters      | Workflow dispatch and shared logical plan/stores      | Claim-response validation and capability policy/configuration.                           |
| Receipt/attempt SDK planning and memory staging      | Registered record creates and contributions           | Receipt schema/key/owner and attempt-fact/transition validation.                         |
| Failure record/state/store helpers                   | Generic operations service and stores                 | Operator authorization, DTO validation and publication reconciler.                       |
| Memory pump and AWS delivery/recovery wrappers       | Shared driver and validated SQS binding               | Bound domain handlers and thin existing endpoint adapters.                               |
| Lab clients/provision/lifecycle/container algorithms | Private shared lab plus public local transport policy | Pure app profile, extra service grants, app/proof scenarios and verification assertions. |
| Upload/object/publisher/job/notification protocols   | No extraction in this iteration                       | Existing domain-specific implementations and tests.                                      |

Migrate one protocol boundary at a time, with adapter/golden tests and the existing app
suite. Transitional facades may preserve imports while converting call sites, but must
delegate rather than retain a second algorithm; remove unused facades before completion.
The existing Work Requests example/template remains on legacy APIs to test opt-in compatibility.

## Leverage Measurement

### Frozen Inputs and Artifacts

Before framework edits, create `leverage/baseline.json`, two task specifications and neutral
acceptance fixtures under this iteration's directory. Record the baseline source commit
(current inspected code is `ae3268551bdda01592c6bdc08a76954e6eb1e02e`; freeze the actual
approved baseline at execution), approved-doc hashes, tool/model settings, lockfile hash,
test commands and per-file/symbol hashes. Do not infer a new commit or create one automatically.

New scripts `measure-leverage.mjs` and `verify-installed-workflow.mjs` belong under root
`scripts/`; root orchestration must include the new private tooling package. Raw task
patches/timing artifacts are ignored, while sanitized specs, counts, results and the final
verdict are reviewable iteration evidence. Do not commit tokens, manifests, raw model
reasoning, full prompts containing credentials or large trace dumps.

### Structural Inventory

Inventory the PRD's selected dispatch/persistence/delivery/failure implementations before
extraction. Record AST symbols/spans, immutable source hashes and classification. For mixed
factories, explicitly exclude domain subtrees such as editor authorization and publication
reconciliation; do not classify whole mixed files as generic to inflate the denominator.

Count physical lines containing nontrivia TypeScript tokens in selected runtime spans,
using the installed TypeScript scanner and canonical repository formatting. Count a shared
line once. Exclude comments, whitespace, tests, docs and build output in both snapshots.
App-maintained generated runtime code is included. Freeze these rules before measurement.

Post-migration accounting includes retained/reintroduced generic algorithms anywhere in
the consumer, not only the old paths, plus the thin composition replacing selected spans.
Review renamed/moved files and generated code; moving a protocol to another app utility
does not retire it. Required reduction is `1 - post / baseline >= 0.50`.

Also disclose framework source growth, new export/concept count, per-app configuration,
domain code retained, secondary token/node counts and both consumers' integration footprint.
Import/dependency checks prohibit app-to-app, private-package/deep imports and hidden copied
protocol implementations. The numeric gate is necessary but does not alone establish leverage.

### Paired Tasks

Task A: a create-only `approvalReceipt` with content/review/revision identity, actor,
approval instant and content version participates in approval's transaction. Seed a
conflicting receipt to prove state/activity/projection/outbox/idempotency all roll back.
Equivalent successful retries yield one receipt in memory and DynamoDB. Use the same
record schema/key and domain expectations in both snapshots.

Task B: `recordPublicationReceipt` subscribes to the existing publication fact and stores
one immutable receipt through an ordinary internal resource command with deterministic
business identity. Add only the domain resource/handler/registration needed for it. Keep
it off public editorial ingress. Transient/terminal failures, authorized targeted replay,
lost acknowledgement and marker deletion must produce one logical receipt. The baseline
may use all current public APIs; do not handicap it by forcing unnecessary SDK rewrites.

For each task, use separate baseline/post worktrees or copies, reset between tasks, and
provide identical specification/acceptance fixtures. Neutral fixtures are applied only by
the task runner, outside default test discovery until the task is implemented. Do not add
knowingly failing benchmark feature tests to normal CI. Do not retain benchmark features
as application scope without separate approval.

Use four fresh user-mediated agent sessions: baseline A/B and post A/B. Opening those
sessions and the agreed model/budget requires user coordination; never automatically spawn
agents, call a paid model API or silently substitute an experienced existing session for
a fresh-context observation. Supply public docs/types and the target checkout, not the
opposite solution patch. Agents may inspect source normally; record when private framework
understanding was necessary. Post tasks must require no framework-internal edits.

Budget each attempt at thirty minutes of active elapsed work, with separately recorded,
bounded install/service waits; record the actual agreed settings before baseline execution.
Capture visible session start/end, tool/test events, correction rounds, modified files and
generic integration source churn. Compute elapsed-with-waits-excluded from the union of
recorded wait intervals, not a claim of model thinking/CPU time. Tokens are `unavailable`
unless the client exposes actual usage. Keep failed/partial attempts and settings deviations.

Judge three independent results: functional equivalence, structural retirement, and reduced
generic integration work across the paired tasks. Report time/tokens as observations with
sample-size/familiarity/hardware/network confounders, not a universal multiplier or proof
against raw AWS SDK development. An inconclusive or negative result is a no-go for the
accelerator claim and requires scope review, not unlimited retries or test relaxation.

## Verification Strategy

### Credential-Free and Compatibility

- Unit/contract tests for scope isolation, equivalent/conflicting targets, logical expiry,
  ambiguous commits, replay-without-decision and stale claim-result rejection.
- Shared memory/Dynamo plan suites for record ownership/schema/key bounds, exact projection
  movement, duplicate/coalesced actions, auxiliary rollback and isolated snapshots.
- Generic delivery/operations suites for strict batch validation before markers, recorded
  replay authorization, CAS races, interrupted collection/replay, bounds and permanent
  business deduplication after marker loss.
- Golden legacy keys/rows/envelopes/DTOs and optional-CDK baseline snapshots. No new queues,
  stores, collectors, grants or IDs when the capability is not opted into.
- No-network import tests and transport-negative probes for public local factories and
  private lab providers. Normal bundles must exclude verification fault-control readers.
- Full existing Content Operations unit/browser suites and new report HTTP/CLI/domain
  acceptance, with no weakened editorial/publication assertions.

All workspace tests run after frozen install and before any package build in an isolated
checkout. Keep the recent Angular source-alias regression and extend source-path verification
for intentional public subpaths. A local prebuild cannot stand in for the clean CI ordering.

### Installed Packages

Build and pack the public packages into an isolated artifact directory. Copy only Report
Runs' consumer source/config and domain fixtures into a temporary project outside the repo;
install tarballs with explicit local dependency overrides for unpublished JawStack versions.
Those overrides target packed artifacts, never workspace directories or `src` entrypoints.

Verify declarations/exports, memory request/worker/result/recovery behavior, and actual
worker/collector AWS bundle builds/imports from that install. Assert no workspace aliases,
private lab/app imports, outside-project source resolution, prebuilt consumer outputs or
implicit registry fetch of unpublished JawStack packages. Import checks create no clients
or AWS requests. Retain the independent Work Requests generated-app verification, including
lint/typecheck/tests/browser and AWS builds/synth/doctor, plus package guard/dry runs.

### Local Integration

Run expensive gates sequentially with fresh explicit lab IDs and no interactive dataset
reuse. First run Content Operations' complete memory browser suite and real LocalStack
browser workflow; then its full deployed application failure/reset/reprovision/teardown
gate against the migrated adapters. Record actual results, not earlier phase passes.

Separately provision Report Runs and drive HTTP/CLI request through actual transaction,
stream dispatcher, EventBridge, SQS, bundled worker and durable result. Exercise automatic
transient retry, three terminal receives, real redrive/collector interruption/retry,
operator replay, marker-loss duplicates, and crash after completion before marking.
No host pump, direct Lambda invocation or accelerated queue visibility substitutes for it.

Use verification-only dependency/lifecycle fault callbacks on the same factories. Normal
bundles have no environment-controlled fault reader or public fault route. Prove owned
function/archive identity before swaps, restore/check standard archives in `finally`,
and preserve failed/no-go evidence if restoration or cleanup fails.

Both profiles must prove unsafe configuration makes zero AWS-bound transport requests,
an unrelated-owner sentinel survives reset, owned resources and warm runtimes disappear,
reprovisioned real workflow succeeds, foreign lookalike cleanup is refused before mutation,
and final down leaves zero owned containers/network with the manifest removed. Cached
images/unrelated projects stay untouched. Missing token/plan is a failing NOT-RUN.

Keep remote CI PR/manual-only and retain the protected default-branch integration boundary.
Adding a report gate must keep per-step/job deadlines finite and run the two live profiles
sequentially; split bounded jobs if the current fifty-minute cloud-job ceiling is insufficient.
Upload only bounded sanitized evidence/screenshots, not env files, manifests or raw Docker
logs. No remote dispatch, secret upload or environment change is authorized by this design.

## Acceptance Traceability

| PRD   | Design and evidence                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC-01 | Scoped executor composition, fixed invocation state, seven-day logical expiry and pinned replay; both adapter suites and live concurrent command checks.           |
| AC-02 | Registered create-only contributions, shared plan/conditions/limits and memory publication; rollback/projection/ownership suites and task A.                       |
| AC-03 | Pre-marker validation/authorization, framework failure store/state machine and transactional targeted outbox; interrupted collector/replay matrix in both domains. |
| AC-04 | App-owned claim/result validator and reconciler, compatibility table/golden fixtures; unchanged content unit/browser/live acceptance.                              |
| AC-05 | Report schemas, internal completion protocol and verified stored export; real headless memory/local happy/failure/recovery paths.                                  |
| AC-06 | Package ownership/import gates, one definition and generic binding, private finite-profile lab; no per-app protocol/provider copies.                               |
| AC-07 | Frozen AST inventory, post-composition accounting and 50% retirement threshold, with framework/API growth disclosed.                                               |
| AC-08 | Four coordinated fresh-session exercises, equivalent neutral tests and visible effort/churn evidence; explicit positive/inconclusive/negative verdict.             |
| AC-09 | Out-of-workspace tarball install, memory workflow and AWS import/bundle verification, no private harness dependency or source aliases.                             |
| AC-10 | Clean test-before-build gate, legacy defaults/IDs, generated-app/package/boundary regressions.                                                                     |
| AC-11 | Sequential actual-service matrices, ordinary retry/redrive, zero-network negatives, owned sentinel reset/reprovision and verified teardown.                        |
| AC-12 | Two public recipes, app/lab instructions and final acceptance/leverage outcome with exclusions and failed/not-run results.                                         |

## Alternatives Rejected

- Moving all Content Operations runtime files into a package: exports editorial assumptions,
  preserves a monolith and does not prove an independently usable contract.
- A generic task/lease/workflow engine: creates another authority beside publication state
  and expands scope beyond the selected delivery/recovery protocol.
- Only generating more application boilerplate: leaves each consumer maintaining the safety
  machinery and does not satisfy protocol retirement or installed-package proof.
- Making every resource use the new runtime: breaks opt-in compatibility and burdens small
  or legacy consumers with unused services.
- Putting local guards only in private test tooling: installed consumers would need to copy
  safety-critical client construction or import private repository modules.
- Requiring CDK deployment into the emulator or real AWS: changes the acceptance surface,
  plan/cost assumptions and security scope rather than demonstrating the selected leverage.
- Building a full from-scratch competitor for the benchmark: consumes the iteration and
  confounds extraction results. Measure the stated before/after baseline honestly instead.

## Planning Handoff and Limits

Create the implementation plan only after this design is reviewed. Capture baseline/specs
and user-coordinated exercise sessions before extraction, then establish logical plan and
dispatch, durable recovery, transport/CDK/local composition, consumer migration, independent
consumer and final evidence. Size phases for implementation -> user review -> user commit;
target roughly 10-15 coherent phases and review a split if actual ownership boundaries
cannot fit, rather than silently expanding the approved iteration.

Do not create placeholder APIs/tests that pass without effects. Do not discard valid
existing assertions to hit the code-reduction metric. Functional completion without positive
reviewed leverage is not the PRD's completion condition. Publication, version bumps, tags,
commits/pushes/merges, real AWS, production auth/IAM claims and remote secret configuration
remain separately authorized work, not consequences of approving this design.
