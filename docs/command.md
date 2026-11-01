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

DynamoDB TTL cleanup is best-effort. The base DynamoDB adapter treats a stored record
normally until deletion; configuring a TTL is not itself a logical expiry guarantee.
Content Operations supplies an invocation-scoped persistence extension with seven-day
logical expiry and conditional expired-row replacement, including before physical TTL
deletion. That is application policy, not a change to the starter's default behavior.

## Application Extensions

Compose `ResourceRepository` / `CommandUnitOfWork` per invocation when scope, logical
expiry, or typed auxiliary records are required. Public AWS item/key mappers and transaction
builders allow this without deep imports. Preserve expected-version checks and the atomic
state/activity/projection/idempotency/outbox commit; do not publish effects directly from
decisions. Bound auxiliary writes and reject duplicate physical transaction keys. The
[composition guide](application-composition.md#core-and-persistence) describes the consumer's
receipt/attempt/expiry protocol and its responsibilities.
