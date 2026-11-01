# @jawstack/aws-runtime

AWS runtime adapters for JawStack applications.

This package contains:

- DynamoDB repository and transactional unit-of-work adapters.
- Bounded paged projection/activity queries compatible with the memory query contract.
- DynamoDB item mappers for state, activity, projections, idempotency, outbox, and worker records.
- API Gateway Lambda handler adapter.
- EventBridge publisher and outbox dispatcher/sweeper.
- SQS worker and EventBridge Scheduler target adapters.

Status: `0.0.1` dogfood baseline. APIs are expected to change before `0.1.0`.

## Paged Queries

`DynamoDbRepository` implements core's `QueryRepository` in addition to its existing
state, idempotency, and legacy array reads. `queryProjection` and `queryActivity` accept
the public core query types and return `Page<T>` with an optional `nextCursor`. Existing
`listProjection` and `getActivity` behavior is unchanged; they are not the new paging API.

```ts
import { DynamoDbRepository } from "@jawstack/aws-runtime";

const repository = new DynamoDbRepository({ client, tableName: "application-state" });
const page = await repository.queryProjection({
  projectionName: "contentItem.calendar",
  sortFrom: "2026-10-01T00:00:00.000Z",
  sortBefore: "2026-11-01T00:00:00.000Z",
  descending: true,
  limit: 50,
});
```

Each call makes at most one DynamoDB Query with `Limit` from 1 through 200 (default 50).
It uses the repository's configured table and consistency (strong by default). Projection
direction defaults to ascending; activity always reads ascending within its resource's
`ACT#` keys. Fixed item-kind filters exclude unrelated record kinds; application search
filters and their candidate budgets remain the consumer's responsibility.

The limit bounds evaluated items, not a promise of a full page. DynamoDB may stop earlier
at its service byte limit or return zero matching items with a `LastEvaluatedKey`. Follow
the cursor even for an empty page. The adapter retains the service's exact continuation
sort key, reconstructs only the selected partition, and validates partition, key shape,
range, direction, and forward progress. Invalid service pages throw a sanitized
`runtime.internal` error; invalid caller queries/cursors throw `query.invalid` before any
SDK request. Transport/service failures are not converted to empty successful pages.

Projection ranges compare complete physical sort keys in UTF-8 byte order: inclusive
`sortFrom`, exclusive `sortBefore`. The query starts at the near boundary for its direction;
the adapter trims/stops at the far boundary, without a scan or an unbounded refill loop.
An exhausted far boundary has no continuation even if DynamoDB has keys outside the range.
The [DynamoDB Query API](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html)
describes its single sort-key comparison, post-read filters, and continuation behavior.

Cursors use core's shared, bounded version-1 codec, including validation before a request
for an empty range. Page sizes may change during continuation; deleted boundary rows need
not still exist. Cursors are unsigned and not authorization credentials, and reads are not
snapshots. Authorize and select permitted projections/resources in application query handlers.

## Application Persistence

Public key/item mappers and `buildCommandTransactWriteItems`,
`buildResourceStateTransactWriteItem`, and `buildProjectionTransactWriteItem` support
application-owned `CommandUnitOfWork` composition. Preserve version conditions, explicit
old projection deletes, and atomic state/activity/outbox/projection/idempotency writes.
The base repository's `idempotencyScope` selects resource type, command, and subject;
the corresponding commit options must use the same scope. TTL is physical cleanup, not
automatic logical expiry or authorization.

Content Operations composes typed auxiliary writes, logical expiry, and bounded/deduplicated
transaction planning above these exports. These are consumer policies, not generic package
defaults or a new arbitrary-write hook. See [Application Composition](../../docs/application-composition.md#core-and-persistence).
