# Iteration 2: Content Operations

Status: complete. Phases 0-24 and final local acceptance passed November 1, 2026.
The outcome records evidence and exclusions; remote CI dispatch/environment setup remain
unperformed. Changes are ready for user review, not automatically committed or released.

## Documents

- [PRD](prd.md)
- [Technical Design](technical-design.md)
- [Implementation Plan and Phase Evidence](implementation-plan.md)
- [LocalStack Evidence](localstack-evidence.md)
- [Acceptance Outcome and Release Assessment](outcome.md)

## Delivered Application

The maintained [Content Operations consumer](../../../apps/content-operations/README.md)
is a second application, not a replacement Work Requests template. Its five Angular views
cover content list/board and detail, review queue/snapshots, calendar/agenda, and operations.
Authors draft and upload verified files; editors approve immutable revisions, schedule
publication, and inspect attempts, notification deliveries, failures, and bounded recovery.

Shared decisions and execution protocols run in credential-free memory or through an
explicitly owned Hobby LocalStack lab. The live path uses actual DynamoDB transactions/
streams, EventBridge, SQS, bundled Lambda workers/collectors, private S3, and automatic
Scheduler targets. Failure acceptance covers normal visibility/redrive waits, interruption
after storage, fenced lease expiry, durable collection, explicit retry/replay, stale delivery
guards, and ownership-safe reset/reprovision/teardown. Direct adapter diagnostics and
injected-clock memory tests are distinguished from deployed evidence.

## Framework and Scope

The consumer motivated additive paged query contracts, browser-safe Angular presentation
types/structured errors, and named CDK worker/scheduler bindings with optional transport
settings. Application-specific editorial authority, scoped persistence/expiry, immutable
objects, jobs, notifications, and recovery remain in the consumer. See
[Application Composition](../../application-composition.md) for those boundaries.

The [CDK composition](../../../apps/content-operations/INFRASTRUCTURE.md) is local-only
and synthesis-tested. Real AWS, production auth, external notifications, API Gateway
execution, IAM enforcement, and Scheduler failed-delivery retry parity are not proven.
Remote CI needs merged workflows and owner-configured environment prerequisites; local
acceptance is not a claim that GitHub Actions has run these changes.

The 25-phase plan follows the [development process](../README.md). Finishing it does not
authorize a package release: the foundation remains the `v0.0.1` Git baseline, packages
are unpublished, and the private consumer does not require a coordinated version bump.
History stays in the PRD/design/plan/evidence; current usage belongs in application and
product guides, not an indefinitely extended phase list.
