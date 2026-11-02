# @jawstack/core

Framework-neutral JawStack contracts and runtime primitives.

This package contains:

- Resource, state, command, event, worker, and schedule definition helpers.
- Work Request starter resource metadata and domain decisions.
- Local in-memory runtime adapters.
- Paged projection/activity query contracts and an in-memory implementation.
- Command execution and validation primitives.
- Manifest and registry validation helpers used by `jawstack doctor`.

Status: `0.0.1` dogfood baseline. APIs are expected to change before `0.1.0`.

## Paged Reads

`QueryRepository` is separate from the command-facing `ResourceRepository`. It provides
`queryProjection(ProjectionQuery): Promise<Page<ProjectionRecord>>` and
`queryActivity(ActivityQuery): Promise<Page<ActivityRecord>>`. `InMemoryRepository`
implements both interfaces. Existing `listProjection` and `getActivity` methods keep their
array results and ordering; existing repository implementations need not add query methods.
`DynamoDbRepository` in `@jawstack/aws-runtime` implements the same query interface.

```ts
import { createInMemoryPersistence, type QueryRepository } from "@jawstack/core";

const { repository } = createInMemoryPersistence();
const queries: QueryRepository = repository;
const first = await queries.queryProjection({
  projectionName: "contentItem.calendar",
  sortFrom: "2026-10-01T00:00:00.000Z",
  sortBefore: "2026-11-01T00:00:00.000Z",
  limit: 25,
});
```

- `Page<T>` contains readonly `items` and an optional `nextCursor`. Pass that cursor to the
  same query to continue; page size may change. An empty page is valid, and an absent
  cursor means that read is exhausted.
- Both methods default to 50 items and accept integer limits from 1 through 200. Projection
  reads default to ascending order; `descending: true` reverses it. Activity reads are
  always ascending and require `resourceType` and `resourceId`.
- Pages need not be full, and service adapters may return an empty page with continuation.
  Follow `nextCursor` even when `items` is empty. Memory and service page boundaries can
  differ while their ordered results agree.
- Ordering is UTF-8 byte order of the existing physical keys, not locale order. Projection
  keys are `sort#itemId`, without adding the suffix again when `sort` already ends in
  `#itemId`. Activity keys are `ACT#occurredAt#activityId`, including the ID tie-breaker.
- `sortFrom` is inclusive and `sortBefore` is exclusive against that complete projection
  sort key. Timestamp prefix bounds work for timestamp-based sorts; full keys select
  boundaries within tied timestamps. Equal bounds return an empty page; reversed bounds
  are invalid. Bounds are valid UTF-8 strings of at most 1,024 bytes.
- Projection names use a resource prefix plus dot-separated nonempty segments, such as
  `contentItem.status.approved` or `asset.content.content_123`. Resource prefixes use the
  existing resource-name syntax; subsequent segments accept letters, digits, `_`, and `-`.
  Physical partition keys are limited to 2,048 UTF-8 bytes.
- Cursors are opaque, versioned, canonical base64url strings, bounded to 4 KiB. They bind
  the continuation key to the query kind, partition, range, and direction, not page size.
  Invalid queries/cursors throw `JawStackRuntimeError` with code `query.invalid`.
- These are keyset reads, not snapshots: deleting the boundary item does not break
  continuation, but inserts or sort changes between reads can change subsequent results.
  Replaying the same cursor is allowed. Returned records are detached copies.

The query API accepts no arbitrary partitions, indexes, expressions, raw database keys,
or filters. Application handlers must authorize and select permitted queries. Cursors are
not signed, secret, or authorization credentials; do not trust decoded cursor contents.
Application-level filtered paging must additionally bind its filter context and preserve
continuation through empty filtered pages; it is not implemented by this core contract.

### Adapter Helpers

`await prepareProjectionQuery(query)` and `await prepareActivityQuery(query)` expose the
same normalization and version-1 cursor validation used by memory. They return typed
`PreparedProjectionQuery`/`PreparedActivityQuery` contexts with normalized `query`, decoded
`after`, `containsKey(key)`, and `cursorAfter(key)`. Cursor writers reject keys outside the
query scope. Adapters reconstruct their own known partition rather than accepting a raw
database request from a caller. These helpers use native Web Crypto for SHA-256; the
existing version-1 cursor format and fingerprints remain compatible.

## Atomic Record Definitions

`defineAtomicRecord` declares a typed, create-only auxiliary record. It does not write
or change existing resource/persistence behavior. Collection names are bounded and may
not use framework-reserved namespaces. Schemas must be Zod object schemas; registration
enforces strict unknown-field handling, and schemas must be stable under revalidation.

```ts
import { z } from "zod";
import { defineAtomicRecord } from "@jawstack/core";

const receipt = defineAtomicRecord({
  name: "approvalReceipt",
  schema: z.strictObject({ contentId: z.string(), reviewId: z.string() }),
  key: (value) => `${value.contentId}#${value.reviewId}`,
  owner: (value) => ({ resourceType: "contentItem", resourceId: value.contentId }),
});

const contribution = receipt.create({ contentId: "content_1", reviewId: "review_1" });
```

Contributions are opaque, detached and tied to the exact registered definition. Casting,
copying or JSON roundtripping does not create a valid contribution. The planner rechecks
schema, UTF-8 key (1-1,024 bytes) and owner against the command root. Values are finite
plain JSON, not dates, binary values, custom prototypes, accessors, sparse arrays or
functions. `PK`, `SK`, `itemKind` and `tenantId` cannot be top-level record data. Key/owner
functions must be pure; they receive frozen data, not runtime clients.

## Memory Workflows

`defineWorkflow` and `createMemoryWorkflow` compose scoped commands, typed record
contributions, validated worker delivery and authorized failure/recovery operations.
Use the [complete public workflow recipe](workflows.md) for declaration, binding,
delivery, replay, bounded draining and lifecycle behavior. No application transaction
builder or custom pump is needed. Nothing starts automatically.

This is an opt-in backend capability, not a migration of existing resources or a durable
database. Memory state is process-local; the Dynamo workflow factory remains planned.
Tenant-bearing traffic is unsupported. Legacy executors/repositories retain their defaults.

## Workflow Adapter Contract

`createWorkflowCommitPlanner` is a **backend adapter-author API**, not a command endpoint,
raw transaction builder or a ready-made workflow runtime. Memory/Dynamo workflow execution
and the higher-level application composition are not implemented by this planner. Existing
executors, repositories and transaction builders retain their defaults.

Configure `workflowName`, expected event `source`, explicit `idempotencyTtlSeconds` (1
through 604,800), optional `records`, optional `maxActions` (1-60), and an optional pure
`contribute({ invocation, commit })`. The invocation supplies captured
`{ scope: { resourceType, commandName, subject }, now }`, with a canonical UTC ISO instant.
The contribution hook receives detached recursively frozen core commit data and returns
only registered `records` and additional `projections`. It must be synchronous; the
contract does not sandbox side effects performed by application closures.

`planner.plan(invocation, coreCommit)` validates a successful scoped core commit and
produces an immutable opaque `WorkflowCommitPlan`. It resolves known key families,
coalesces identical projection puts/exact delete-put pairs (put wins), and rejects other
physical collisions. It preserves core response/fingerprint data and event property order.
Create/update versions, actor/time/target/source and response metadata must agree; tenant
metadata and command-authored recovery delivery metadata are unsupported.

`WorkflowCommitStore.commit(plan)` is the minimal storage interface for adapters. Before
effects, an implementation must use its **bound** `planner.validate(plan)`: plans from a
different planner, plain objects, casts and cloned/deserialized plans reject. This producer
identity is not an authorization system or protection from arbitrary trusted backend code.
Do not expose a store/planner as a public HTTP write API.

Actions carry backend-neutral `partition`/`sort` identities from `workflowRecordKeys`,
not SDK requests. Primary writes require absence or exact version; activity, outbox and
auxiliary creates require absence, including when a row already exists in storage.
Scoped idempotency requires absence or logical expiry at the captured instant. Adapters
must enforce every condition atomically, classify idempotency versus other conflicts,
and never split the plan into separate commits. `createMemoryWorkflow` now ships a complete
implementation of these conditions. Consumers use that factory, not package internals.

Backend adapter authors can use `createWorkflowRuntime(definition, createStorage, options)`.
Its synchronous factory receives the bound `planner`, failure `protocol` and immutable
`manifest`, and must return all `WorkflowStorage` ports: scoped command persistence,
resource reads, keyset queries, registered record reads, failure CAS/outbox commits and
processing/collection markers. There are no missing-service fallbacks. An optional storage
`close` releases adapter-owned resources; caller-owned clients must not be destroyed.
The common runtime owns binding, authorization, delivery order and lifecycle, not SDK calls.
See the [adapter responsibilities](workflows.md#adapter-authors) and
[Phase 4 evidence](../../docs/iterations/003-framework-leverage/phase-4-evidence.md).

`workflowCommitLimits` exposes the shared bounds: 60 normalized actions, 192 KiB per
logical action, 64 KiB per auxiliary action (including key/owner metadata), 1 MiB for the
normalized plan, depth 16 and 10,000 JSON nodes. Detached input admission also bounds JSON
work/bytes before normalization. Limits are checked before storage; duplicate coalescing
cannot bypass record limits. Service compilers must still check their encoded request
limits. These opt-in rules do not change legacy APIs or provision stores/queues/collectors.
