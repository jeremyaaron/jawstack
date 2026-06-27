# Changelog

## v0.0.1 - Dogfood Baseline

This is the first JawStack dogfood baseline. It is intended to be merged and tagged in Git, not published to npm.

What works:

- pnpm monorepo with publishable package boundaries.
- Work Requests generated app template.
- Local Angular UI and local Node API adapter.
- Core resource, command, activity, event, projection, idempotency, and manifest primitives.
- AWS runtime adapters for DynamoDB, Lambda HTTP, EventBridge outbox, SQS workers, and Scheduler targets.
- AWS CDK construct for the resource workflow backend.
- `create-jawstack` local generator.
- `jawstack doctor`, `manifest`, `deploy`, `smoke`, and `destroy`.
- Generated-app verification from a clean temporary app.
- Opt-in AWS dev deploy smoke path.
- Public MVP docs and internal planning archive.
- Package dry-run verification for all publishable packages.

Known limits:

- Packages are not published to npm.
- The generator creates one Work Requests starter workflow.
- `jawstack smoke` is Work Request-specific.
- There is no regeneration or upgrade workflow for edited generated apps.
- Production auth adapters and frontend hosting are not implemented.
- APIs are expected to change before `0.1.0`.
