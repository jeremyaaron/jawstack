# Iteration 2: Content Operations

Status: Phases 0-6 complete. The headless content/review aggregate and full workspace
regression verification passed. Phase 7 has not started.

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
harness and headless editorial domain. HTTP, worker orchestration, and editorial screens
remain unimplemented.
Angular components now accept browser-safe presentation definitions and the fetch client
exposes structured API errors; these contracts do not implement the editorial screens.
Named CDK worker/scheduler bindings now support application-owned grants and DLQ collectors
without construct-tree inspection. The consumer now supports draft/review/approval decisions
through public core commands; scoped dispatch and persistence composition begin in Phase 7.
