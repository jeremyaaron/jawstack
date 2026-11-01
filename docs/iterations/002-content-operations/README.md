# Iteration 2: Content Operations

Status: Phases 0-15 complete. Angular workbench/draft editing, browser-safe client/bundle,
desktop/mobile memory browser tests, and workspace regressions passed. Phase 16 is next.

## Documents

- [PRD](prd.md)
- [Technical Design](technical-design.md)
- [Implementation Plan](implementation-plan.md)
- [LocalStack Evidence](localstack-evidence.md)

## Intended Outcome

Build a maintained content-operations reference application under `apps/content-operations`.
Use it to prove multiple resources, custom Angular workflows, durable asynchronous work,
scheduled behavior, and object storage without requiring a real AWS account for normal
development or acceptance testing.

The iteration includes a bounded LocalStack compatibility gate and only the framework
improvements required by the consumer. It does not commit to a broad CMS framework,
package publication, or a `v0.0.2` release.

The implementation plan follows the [repository development process](../README.md), with
25 reviewable phases beginning with the two-phase LocalStack feasibility gate. The live
gate now covers the event spine, S3, automatic Scheduler, actual DLQ collection, and
ownership-safe reset/reprovisioning; production-parity exclusions are recorded explicitly.
The [consumer README](../../../apps/content-operations/README.md) describes the current
harness and headless editorial domain. Shared handlers and an explicit memory pump now
materialize related resources and deliver notifications; live consumer transport
orchestration and later editorial screens remain unimplemented.
Angular components now accept browser-safe presentation definitions and the fetch client
exposes structured API errors. Phase 15 consumes these contracts in the workbench/editor.
Named CDK worker/scheduler bindings now support application-owned grants and DLQ collectors
without construct-tree inspection. The consumer now supports draft/review/approval decisions
through public core commands with invocation-scoped memory/DynamoDB dispatch, logical
idempotency expiry, atomic command receipts, and bounded/deduplicated projection transactions.
The live gate also checks scoped replay, expiry, rollback, consumer projection moves, and
immutable attachment uploads with interrupted-completion recovery. Content owns bounded
attachment slots and freezes verified references for review; the asset read model has
internal materialization primitives. Phase 9 adds their shared source-version-aware handlers,
durable local notification sink, and deterministic bounded memory outbox pump. Notification
atomicity has memory/SDK contracts, not a live consumer deployment. HTTP upload/download
routes are now implemented in Phase 14; deployed consumer worker/Scheduler targets remain later work.

Phase 10 adds schedule generations, frozen publication intent, 90-second fenced claims,
bounded attempts/retry generations, and atomic redacted attempt history in memory/DynamoDB.
Publication remains locked through failure/lease expiry, and stale claim-response replay
does not grant a usable lease. Phase 11 adds stable versioned JSON serialization/digest,
conditional write/verification, fenced publication execution, success/failure notifications,
and the real publisher in the memory pump. Crash/lease/marker-gap tests and a focused live
DynamoDB/S3 scenario pass. A separate SQS publisher bundle uses the framework adapter and
marks only after domain completion; deploying consumer queue/mapping wiring remains Phase 20.
The latest full live gate also reran earlier transport, scheduling, DLQ, reset, and reprovision
checks, then stopped the owned lab. Phase 12 adds bounded recurring job handlers with fixed
cutoffs, persisted leases/cursors, UTC-day reminder facts/notifications, Temporal gap/fold
rejection, upload expiry, and safe conditional orphan deletion. Explicit memory ticks and
bundled Scheduler entrypoints exist; consumer Scheduler deployment remains Phase 20. Live
checks prove the shared jobs on real DynamoDB/S3 with an injected clock, not deployed targets.
Tombstones and verified historical objects remain retained. Phase 13 adds permanent bounded
failure/recovery history, resumable collection, live/expired publication reconciliation,
editor retry of explicit stalled delivery, atomic targeted outbox replay, owned CLI inspection/
replay, and shared SQS collector/worker bundles. Memory uses the same policies. Direct live
adapter checks prove durable state/marker ordering and one logical delivery/artifact after
recovery; this is not deployed consumer queue evidence.

Phase 14 adds the [loopback API](../../../apps/content-operations/API.md), fixture identity
resolution, public-command allowlist, bounded query cursors, structured conflicts, actual
uploads/downloads, and verified committed publication previews. Explicit memory mode runs
managed handlers/jobs; explicit LocalStack mode checks owned DynamoDB/private S3 and does not
substitute host calls for undeployed consumer workers. The deterministic seed preserves
existing edits. HTTP-only workflow, transport/security/limits, query-budget, shutdown, and
live HTTP service-boundary checks pass.

Phase 15 adds the [Angular workbench](../../../apps/content-operations/WORKBENCH.md): real
content list/board, URL status/title/author filters, bounded continuation, fixture selection,
create/detail and reactive draft forms, structured version-conflict comparison, and explicit
unsaved-change guards. Client requests use the fixed fixture header, public shared schemas,
and stable intent keys on ambiguous retries. Vite checks the actual browser module graph
without a Node shim or server/AWS imports. Isolated Playwright servers exercise desktop/
mobile memory workflows and produce screenshots without touching the development dataset.
The next phase implements review submission, snapshots/decisions, and paged activity.
