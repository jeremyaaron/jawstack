# Command

A command is a validated and authorized intent to change resource state.

Examples from the Work Requests starter:

- `create`
- `assign`
- `changeStatus`
- `comment`
- `close`

## Command Flow

```text
resolve auth
validate input
load current state
run decision function
commit state, activity, projection, idempotency, and outbox records
return command result
```

Command decision functions contain domain rules. They should not publish EventBridge events directly or perform long-running side effects.

## Validation And Authorization

Command input is validated before domain decisions run. Command role checks are enforced server-side. UI role checks are only convenience behavior.

## Idempotency

Commands may include an idempotency key.

Expected behavior:

- Same key and equivalent payload returns the stored result.
- Same key and different payload returns an idempotency conflict.
- Idempotency records are committed in the same transaction as the state change.

DynamoDB TTL cleanup is best-effort. Until AWS deletes an idempotency record, JawStack treats it normally.
