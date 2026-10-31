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
The DynamoDB query implementation follows in Iteration 2 Phase 3.

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
