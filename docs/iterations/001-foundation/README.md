# Iteration 1: Foundation

Status: archived planning record for the merged, Git-tagged `v0.0.1` dogfood baseline.

## Documents

- [PRD](prd.md)
- [Technical Design](technical-design.md)
- [Implementation Plan](implementation-plan.md)

## Outcome

This iteration established the TypeScript workspace, resource and command contracts, local
runtime, AWS adapters and CDK infrastructure, Angular resource views, CLI, Work Requests
starter, generated-app verification, package checks, and initial product documentation.

The original plans frequently refer to a `v0.1` target. The actual release decision was a
Git-only `v0.0.1` foundation, not an npm publication or a claim of production readiness.
The final `0.1.0` release-candidate phase was deferred.

These documents retain design proposals and acceptance criteria that are not necessarily
implemented or verified, including optional real-AWS deployment checks. They are not the
current product reference or proof of deployment.

Use the [changelog](../../../CHANGELOG.md), [product documentation](../../README.md), and
[release checklist](../../release-checklist.md) for the baseline's capabilities and limits.
Subsequent work is planned in [Iteration 2](../002-content-operations/README.md).
