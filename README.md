# JawStack

Build event-driven AWS apps with typed resource contracts, predictable architecture, and cost guardrails.

JawStack is an opinionated TypeScript framework for resource workflow applications. A generated JawStack app gives you an Angular UI, a local API, AWS Lambda runtime handlers, DynamoDB state storage, EventBridge events, SQS worker wiring, Scheduler jobs, CDK infrastructure, and CLI checks from one resource definition.

The MVP starter is intentionally narrow: it ships a Work Requests workflow that demonstrates create, assign, comment, status change, close, list, detail, activity history, events, outbox dispatch, and dev deployment.

## Status

JawStack is pre-release. The repository is ready for a `v0.0.1` dogfood tag, generated-app verification, package dry-run checks, and opt-in AWS dev deploy smoke testing. Package publication and npm release automation are still on the roadmap.

## Quickstart

Prerequisites:

- Node.js 22 or newer
- pnpm 10 or newer

Install and verify the workspace:

```sh
nvm use
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm verify:generated
pnpm verify:pack
```

For the full pre-tag gate:

```sh
pnpm verify:release
```

Run the demo app locally:

```sh
pnpm dev:api
```

In another terminal:

```sh
pnpm dev:web
```

Open `http://127.0.0.1:4316`.

Generate an app from the local checkout:

```sh
pnpm --filter create-jawstack run build
node packages/create-jawstack/dist/cli.js ../my-jawstack-app --local-package-root "$PWD"
cd ../my-jawstack-app
pnpm install
pnpm doctor
pnpm typecheck
pnpm test
pnpm build
pnpm synth
```

When `create-jawstack` is published, the generated-app entrypoint becomes:

```sh
npm create jawstack@latest my-jawstack-app
```

## Deploy To AWS

JawStack deploys through AWS CDK. The deploy path is opt-in because it creates real AWS resources.

```sh
export AWS_PROFILE=jawstack-dev
export AWS_REGION=us-east-1
pnpm --filter demo-work-requests run doctor:deploy
pnpm --filter demo-work-requests run deploy:dev
pnpm --filter demo-work-requests run smoke:dev
pnpm --filter demo-work-requests run destroy:dev
```

The guarded one-command dev cycle is:

```sh
JAWSTACK_AWS_DEV_CONFIRM=deploy-dev pnpm aws:dev:smoke
```

See [Deploy To AWS](docs/deploy-to-aws.md) and [Destroy Your Stack](docs/destroy-your-stack.md).

## Generated Architecture

The generated app is a normal TypeScript project that you own:

```text
jawstack.config.ts
cdk.json
src/
  api.ts
  app.component.ts
  example.ts
  work-request.pages.ts
  aws/
    api.ts
    outbox.ts
    runtime.ts
    send-notification-worker.ts
    stale-work-request-reminder.ts
  cdk.ts
scripts/
  build-aws-entrypoints.mjs
```

The deployed dev stack includes:

- API Gateway HTTP API
- Lambda API handler
- DynamoDB table with stream, TTL, state, activity, projections, idempotency, and outbox records
- EventBridge custom event bus
- Outbox dispatcher Lambda
- Outbox sweeper Lambda and schedule
- CloudWatch log groups with explicit retention
- Worker and scheduler infrastructure when resources define workers or schedules

See [Architecture Overview](docs/architecture-overview.md).

## Core Concepts

- [Resource](docs/resource.md): the domain object and source metadata for state, commands, events, views, workers, and schedules.
- [Command](docs/command.md): a validated and authorized intent to change resource state.
- [Event](docs/event.md): a typed fact emitted after a successful command and published asynchronously through the outbox.
- [Worker](docs/worker.md): an idempotent async consumer wired through EventBridge, SQS, and Lambda.
- [Schedule](docs/schedule.md): an EventBridge Scheduler trigger for recurring or delayed work.
- [Cost Profile](docs/cost-profile.md): explicit guardrails for Lambda, DynamoDB, queues, EventBridge, and schedules.

## Work Requests Example

The starter resource is `workRequest`. It supports:

- `create`
- `assign`
- `changeStatus`
- `comment`
- `close`

The UI includes a work request list, create form, detail view, command forms, and activity timeline. The same resource metadata drives local runtime behavior, AWS runtime behavior, `jawstack doctor`, `jawstack manifest`, and Angular resource views.

## Cost Guardrails

JawStack makes cost-sensitive defaults visible and validated. It does not promise a universal hard spending cap.

The starter cost profile sets:

- Lambda timeout, max timeout, memory, and reserved concurrency
- DynamoDB on-demand billing and explicit read/write request-unit guardrails
- Queue max concurrency, max receive count, and DLQ requirement
- Scheduler retry, event age, and DLQ requirement
- EventBridge loop and schema-version checks

Run:

```sh
pnpm doctor
pnpm doctor:deploy
```

See [Cost Profile](docs/cost-profile.md).

## Packages

- `@jawstack/core`
- `@jawstack/aws-runtime`
- `@jawstack/aws-cdk`
- `@jawstack/angular`
- `@jawstack/cli`
- `create-jawstack`

## Documentation

Start with [docs/README.md](docs/README.md).

Planning documents are still available for contributors:

- [PRD](docs/prd.md)
- [Technical Design](docs/technical-design.md)
- [Implementation Plan](docs/implementation-plan.md)
- [Release Checklist](docs/release-checklist.md)

Early vision drafts are archived under `docs/internal/`.

## Roadmap

Near-term:

- Make the generated app meaningfully customizable beyond Work Requests
- Generalize smoke tests beyond the Work Requests resource
- Add Changesets and npm publish workflow when packages are worth publishing

Post-MVP directions:

- Production auth adapters, including Cognito
- OpenAPI and typed client generation
- Static docs generation from `jawstack manifest`
- Richer workflow profiles and reusable capability modules
- Additional persistence and deployment adapters
- Frontend hosting construct
