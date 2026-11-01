# Task A: Atomic Approval Receipt

This specification and its acceptance fixtures are identical for baseline and post sessions.
Work only in the supplied disposable checkout. Do not commit/push or retain this feature
in the shipping app. Record session settings/start before coding; see the packet README.

## Requested Change

Add a typed create-only `approvalReceipt` to ordinary Content Operations approval. The
receipt is owned by the approved content aggregate and records exactly:

```ts
{
  kind: "approvalReceipt",
  contentId,
  reviewId,
  revisionId,
  actor: "editor_1",
  approvedAt,
  contentVersion,
}
```

Key it logically by content ID and review ID (`OPS#approvalReceipt`,
`<contentId>#<reviewId>` in DynamoDB). Approval instant and committed content version come
from the actual command, not a second clock/read. Use the current invocation's resolved
editor, frozen review and revision. Do not change editorial authorization/approval rules.

The receipt and approval state/activity/projections/outbox/idempotency commit atomically
in memory and DynamoDB. A pre-existing receipt rejects with `resource.conflict`, with no
other category changed. Concurrent equivalent approval retries return the original response
and one receipt. No direct second write after a successful approval. Do not bypass the app
dispatcher or weaken existing tests. All current supported APIs are available to baseline;
do not rewrite SDK plumbing unnecessarily. Post must use public framework contracts without
framework-internal edits or reimplementing extracted plumbing.

## Neutral Acceptance Port

Implement `createApprovalHarness` in
`apps/content-operations/test/leverage-adapter.ts` as specified in `contracts.ts` and
`candidate.d.ts`. This is a thin test adapter, not the feature implementation. Delegate to
the real modified app commands, adapters and stores. The runner uses `memory` and `dynamo`;
the latter is the existing narrow transactional SDK double, not a claim of live DynamoDB.

Initialize the fixed clock/content ID from `fixture`; create and submit normally so the
content is version 2 with one pending review. Expose actual review/revision IDs and the
original version through `context`. `approve(key)` always submits the same version-2
approval with its frozen IDs, editor fixture and a nonempty note. Resolve identity as the
app normally does. `seedReceipt` inserts an exact conflicting raw record before approval.

`snapshot()` captures complete deterministic state, activity, outbox, projections,
idempotency and auxiliary records from the actual backing stores. Do not filter away
effects that would invalidate rollback. `receipts()` reads real stored approval receipts,
not an expected-value cache. Close owned resources in `close()`; default tests need no cloud.

`current()` reads the actual content state/version and `effects()` counts actual aggregate
activity, outbox and scoped idempotency entries. Approval adds one activity/fact/idempotency
entry. Do not run unrelated background consumers during this command-only harness.

Run from the repository root:

```sh
pnpm leverage:exercise --task a --adapter apps/content-operations/test/leverage-adapter.ts
pnpm --filter content-operations test
```

Include app typecheck/lint and relevant regressions. The neutral suite has four cases,
success/retry and conflict/rollback for each adapter. Do not edit the task/fixture/runner
to get a pass. No production HTTP route or UI is required for this internal record.
