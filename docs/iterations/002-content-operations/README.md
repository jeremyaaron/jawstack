# Iteration 2: Content Operations

Status: Phases 0-2 complete. Core paged queries and the public-contract regression gate
passed. The local feasibility gate remains go. Phase 3 has not started.

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
harness. The editorial application remains unimplemented.
