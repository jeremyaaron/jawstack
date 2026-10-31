# Iteration 2: Content Operations

Status: Phases 0-9 complete. Shared materializers, atomic notification delivery, headless
memory flow, and workspace regressions passed. Phase 10 has not started.

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
materialize related resources and deliver notifications; HTTP, live consumer transport
orchestration, publication, and editorial screens remain unimplemented.
Angular components now accept browser-safe presentation definitions and the fetch client
exposes structured API errors; these contracts do not implement the editorial screens.
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
routes, automatic cleanup, and durable failure recovery remain later work.
