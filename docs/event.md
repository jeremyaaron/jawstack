# Event

An event is a typed fact emitted after a successful command.

JawStack v0.1 is state-first and event-emitting. Events are not the source of truth.

## Event Publication

Commands write outbox records in the same transaction as state, activity, projections, and idempotency.

```text
command transaction
  -> OUTBOX_EVENT item with status PENDING
  -> DynamoDB stream
  -> outbox dispatcher Lambda
  -> EventBridge PutEvents
  -> outbox status PUBLISHED
```

The outbox pattern prevents a command from changing state while losing the event record.

## Delivery Semantics

- Publication is at least once.
- Consumption is at least once.
- Ordering is best-effort in v0.1.
- Consumers must be idempotent.

If the dispatcher publishes successfully but fails before marking an outbox record published, EventBridge may receive the event again. Workers should use `eventId` or their own idempotency strategy for side effects.

## Activity Is Separate

Activity records are user-visible audit history. Events are integration facts. They can describe similar business changes, but they have different storage and delivery paths.
