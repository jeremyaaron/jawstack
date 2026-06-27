# JawStack PRD

## Summary

JawStack is an opinionated TypeScript framework for building event-driven AWS applications with typed resource contracts, predictable generated architecture, and explicit cost guardrails.

The first release focuses on one complete vertical slice: a deployable resource workflow application for "Work Requests." A generated JawStack app should let a developer create, assign, comment on, update, close, list, and inspect work requests through an Angular UI backed by API Gateway, Lambda, DynamoDB, EventBridge, SQS, EventBridge Scheduler, and AWS CDK.

The MVP is intentionally narrow. It is not a universal product generator. It proves that one common product primitive can be declared once as a resource, then used by runtime handlers, infrastructure constructs, local tests, CLI checks, and Angular resource components.

JawStack should feel like a serious developer tool: small enough to understand, opinionated enough to be useful, and explicit enough that developers can trust what it deploys.

## Package Identity

The public product name is `JawStack`.

The original project idea used `JAWS` as a codename, but the public identity should avoid leaning on that name because it collides with the long-running screen reader product. Documentation may mention JAWS as the origin story, but public package and CLI naming should use JawStack.

Initial package names:

```text
@jawstack/core
@jawstack/aws-runtime
@jawstack/aws-cdk
@jawstack/angular
@jawstack/cli
create-jawstack
```

Initial binaries:

```text
create-jawstack
jawstack
```

Primary app creation flow:

```sh
npx create-jawstack my-app
cd my-app
pnpm install
pnpm jawstack doctor
pnpm jawstack deploy dev
```

The repository may start as an unpublished monorepo while the kernel stabilizes. Public release should wait until the generated app can be installed, tested, deployed, smoke-tested, and destroyed from documented commands.

## Problem

Teams building real product software on AWS often need the same architectural pieces:

- User-facing resources with state and lifecycle transitions.
- Commands that validate intent and enforce authorization.
- Activity timelines and audit trails.
- Domain events for integration and async work.
- Background workers with retries and dead-letter queues.
- Scheduled jobs for reminders, timeouts, or stale-item processing.
- CRUD-like views that are more workflow than database table.
- Cost and scaling limits that are explicit before deployment.
- Documentation and project structure that make the architecture understandable.

AWS provides the primitives, but developers still have to assemble API Gateway, Lambda, DynamoDB, EventBridge, SQS, Scheduler, IAM, alarms, budgets, local test adapters, frontend wiring, and deployment scripts themselves. Starter templates help with setup, but they usually expose infrastructure primitives instead of domain concepts. Application frameworks help with local ergonomics, but often do not produce a complete low-fixed-cost AWS architecture.

Common failure modes include:

- A project starts with generic CRUD and later bolts on events, workers, and audit history inconsistently.
- Lambda, SQS, and EventBridge defaults allow more fan-out or runtime cost than intended.
- Domain events are published directly after state writes, creating half-failure cases.
- Local development diverges from deployed behavior.
- Generated code becomes hard to upgrade or understand.
- Frontend workflows, backend commands, and infrastructure drift apart.
- The first deploy is unclear, expensive, or hard to destroy.
- Documentation describes intentions rather than executable contracts.

JawStack should solve a focused version of this problem for TypeScript developers who want a canonical path for evented resource workflow apps on AWS.

## Goals

- Let developers create a complete deployable AWS resource workflow app from one command.
- Provide a typed `defineResource()` model that becomes the source of truth for commands, events, views, runtime routing, infrastructure, checks, and documentation metadata.
- Make current resource state explicit and separate from activity records, outbox events, and projections.
- Commit state changes, activity records, idempotency records, and outbox events atomically.
- Publish committed domain events asynchronously through EventBridge.
- Provide a useful Angular resource workflow UI without becoming a general-purpose component library.
- Make cost and scaling guardrails part of the framework contract.
- Keep local development fast without pretending to fully emulate AWS.
- Generate apps that users own and can edit normally.
- Keep the first public release narrow, documented, testable, and safe to destroy.

## Non-Goals

- Building a universal product generator in the MVP.
- Supporting every product class, profile, or vertical domain in v0.1.
- Implementing event sourcing in v0.1.
- Making EventBridge or events the source of truth.
- Guaranteeing a universal hard AWS spending cap.
- Replacing AWS CDK.
- Replacing Angular, Angular Router, or Angular forms.
- Providing a full UI component library.
- Requiring Cognito or any specific production identity provider in v0.1.
- Supporting Aurora, relational migrations, ORMs, or VPC-based app architecture in v0.1.
- Supporting ECS workers in v0.1.
- Building a local AWS emulator.
- Providing a plugin ecosystem before the core contracts stabilize.
- Providing AI-agent-specific runtime behavior in v0.1.
- Promising automatic upgrades for heavily edited generated apps.

## Target Users

### Primary User

A TypeScript developer building a small-to-medium internal tool, workflow app, support queue, moderation queue, review process, developer portal feature, or operational dashboard that needs a real AWS deployment path.

They are comfortable with TypeScript and can work with Angular and AWS concepts, but they want a framework that starts from product concepts instead of raw cloud primitives.

### Secondary Users

- Solo developers and side-project builders who want bounded AWS architecture without days of setup.
- Platform-minded engineers standardizing internal app patterns.
- Teams building admin workflows, approval flows, intake queues, or task systems.
- Developers who like AWS CDK but want a higher-level application pattern.
- Engineers evaluating event-driven serverless architecture with a concrete example.
- Documentation-minded maintainers who want generated apps to explain their own architecture.

## Positioning

JawStack should be positioned as a framework starter for event-driven AWS resource workflow applications, not as a general cloud framework.

Suggested tagline:

> Build event-driven AWS apps with typed resource contracts, predictable architecture, and cost guardrails.

Short description:

> JawStack turns a TypeScript resource definition into a deployable Angular and AWS application pattern with commands, state, activity, events, workers, schedules, and guardrails.

Avoid positioning such as:

```text
The framework for every digital product.
The Rails of serverless.
Hard-capped AWS apps.
No-code AWS generation.
Full-stack app builder for all domains.
```

## Product Principles

- Start from domain resources, not cloud primitives.
- Make the boring architecture canonical and visible.
- Prefer explicit framework contracts over hidden magic.
- Keep current state as the source of truth for v0.1.
- Treat events as durable facts for integration and activity, not as the only persistence model.
- Commit state and outbox records atomically before publishing events.
- Assume event publication and consumption are at least once.
- Require async consumers to be idempotent.
- Keep cost guardrails honest: distinguish hard limits, soft limits, best-effort limits, and alert-only controls.
- Make unsafe deployment choices visible in `jawstack doctor`.
- Optimize for clear errors, predictable project structure, and trustworthy docs.
- Keep generated apps user-owned.
- Add abstraction only when it removes repeated real-world wiring.

## MVP Scope

The v0.1 product supports one generated app pattern: a resource workflow application.

The generated example resource is `WorkRequest`.

The generated app demonstrates:

- Create a work request.
- Assign a work request.
- Change work request status.
- Add comments.
- Close a work request.
- List work requests.
- View a work request detail page.
- View activity history.
- Emit typed domain events after successful commands.
- Dispatch committed outbox events to EventBridge.
- Run one queued async worker from an event.
- Run one scheduled stale-item reminder example.
- Validate project safety and deploy readiness with `jawstack doctor`.
- Deploy and destroy a dev AWS environment through documented commands.

## Core Concepts

### Resource

A domain object with current state, commands, events, views, and optional jobs.

For v0.1, `WorkRequest` is the canonical resource.

### Command

A validated and authorized intent to change resource state.

Commands run domain decision functions. They should not directly publish domain events or perform long-running work.

### State

The current resource state stored in DynamoDB. State is the source of truth in v0.1.

### Activity

A durable, append-only audit record shown in the UI. Activity records describe user-visible changes and command outcomes.

### Event

A typed fact emitted after a successful state change. Events are integration messages and may also be represented in activity history.

### Outbox Event

A durable event record committed in the same transaction as the state change. Outbox events are later published to EventBridge by a dispatcher.

### Projection

A derived read model used for list, detail, or query UX. Projections are not the source of truth.

### Worker

An async consumer of events or queue messages. v0.1 supports SQS to Lambda workers.

### Schedule

An EventBridge Scheduler-driven recurring or one-time trigger. v0.1 includes a stale-item reminder example.

### Cost Guardrail

Explicit configuration, validation, or infrastructure that reduces runaway behavior or makes cost risk visible.

## Runtime Model

JawStack v0.1 is state-first and event-emitting. It is not event sourcing.

The command path is:

```text
Command request
  -> resolve auth context
  -> validate input
  -> load current resource state
  -> run domain decision function
  -> commit state, activity, idempotency, projection, and outbox records
  -> return command result
```

A successful command means:

- The resource state change was committed.
- The activity record was committed.
- The idempotency record was committed when an idempotency key was provided.
- Any in-transaction projection updates were committed.
- The outbox event was committed.

A successful command does not mean:

- EventBridge publication has completed.
- Async workers have run.
- Notifications have been sent.
- All projections have caught up.
- External integrations have succeeded.

Domain event publication is asynchronous:

```text
DynamoDB outbox record
  -> outbox dispatcher
  -> EventBridge PutEvents
  -> outbox status update
```

Event delivery semantics:

- Publication is at least once.
- Consumption is at least once.
- Consumers must be idempotent.
- Ordering is best-effort per resource in v0.1.
- Stronger ordering guarantees are future work.

## Resource Definition API

The MVP exposes executable TypeScript metadata, not a separate language and not a heavy code generator.

Conceptual example:

```ts
export const workRequestResource = defineResource({
  name: "workRequest",
  title: "Work Request",

  state: defineState({
    title: field.string({ required: true }),
    description: field.text(),
    status: field.enum({
      values: ["open", "inReview", "blocked", "closed"],
      default: "open",
    }),
    assigneeId: field.string(),
  }),

  commands: {
    create: defineCommand({
      title: "Create Work Request",
      input: createWorkRequestInput,
      roles: ["user"],
      decide: createWorkRequest,
    }),

    assign: defineCommand({
      title: "Assign",
      input: assignWorkRequestInput,
      roles: ["manager"],
      decide: assignWorkRequest,
    }),

    close: defineCommand({
      title: "Close",
      input: closeWorkRequestInput,
      roles: ["manager"],
      decide: closeWorkRequest,
    }),
  },

  views: {
    list: defineListView({
      columns: ["title", "status", "assigneeId", "updatedAt"],
    }),

    detail: defineDetailView({
      titleField: "title",
      sections: ["summary", "activity", "comments"],
    }),
  },
});
```

The resource definition should be consumed by:

- Runtime command routing.
- Runtime validation and authorization checks.
- CDK construct configuration.
- Angular resource shell components.
- `jawstack doctor`.
- `jawstack manifest`.
- Future documentation and API generation.

The resource definition should not require source-file parsing in v0.1.

## Generated App

`create-jawstack` creates a normal TypeScript, Angular, and CDK app that users own.

Expected generated structure:

```text
src/
  app/
    resources/
      work-request.resource.ts
    features/
      work-requests/
    shared/

api/
  handlers/
  runtime.ts

infra/
  app.ts
  stacks/
    jawstack-app-stack.ts

jawstack.config.ts
```

Framework-owned surfaces:

- `@jawstack/core`
- `@jawstack/aws-runtime`
- `@jawstack/aws-cdk`
- `@jawstack/angular`
- `@jawstack/cli`

User-owned surfaces:

- Resource definitions.
- Command decision functions.
- Domain logic.
- Angular customization.
- CDK app composition.
- Environment configuration.
- Styling.

v0.1 should not promise conflict-free regeneration or whole-app upgrades.

## CLI Commands

The MVP exposes the app generator and the `jawstack` project CLI.

### `create-jawstack`

Creates a new generated app.

```sh
npx create-jawstack my-app
```

Expected behavior:

- Copy the starter app.
- Install no dependencies automatically unless explicitly confirmed or documented.
- Print next steps.
- Keep generated files ordinary and editable.
- Include the Work Requests example by default.

### `jawstack doctor`

Validates resource definitions, project configuration, cost guardrails, auth mode, and AWS deploy readiness.

```sh
pnpm jawstack doctor
```

Expected checks:

- Resource definitions are loadable.
- Resource and command names are unique and valid.
- Command handlers exist.
- Command inputs are valid schemas.
- Event schema versions are present.
- Auth provider is configured.
- Dev auth is not deployable to AWS unless explicitly allowed.
- Lambda timeout, memory, and concurrency settings are explicit.
- SQS workers have maximum concurrency.
- SQS queues have DLQs and max receive counts.
- DynamoDB billing and throughput guardrail settings are explicit.
- EventBridge Scheduler retry and DLQ settings are explicit.
- Suspicious EventBridge self-triggering paths are reported.
- Required AWS environment settings are present for deploy checks.

Expected output:

- Human-readable grouped findings by default.
- Stable finding codes.
- Clear severity.
- Concise impact and fix guidance.
- JSON output later if needed for CI and editor integrations.

### `jawstack manifest`

Outputs a JSON description of the configured JawStack app.

```sh
pnpm jawstack manifest
```

The manifest should include:

- App name.
- Stage.
- Resources.
- Commands.
- Events.
- Views.
- Workers.
- Schedules.
- Cost guardrail settings.
- Auth provider mode.

The manifest is the future base for docs, API generation, OpenAPI, and typed client generation.

### `jawstack deploy <stage>`

Deploys the CDK app for a stage.

```sh
pnpm jawstack deploy dev
```

Expected behavior:

- Run or require `jawstack doctor` checks before deployment.
- Fail unsafe deploys unless explicitly overridden.
- Delegate infrastructure deployment to CDK.
- Print deployed API and frontend URLs when available.

### `jawstack smoke <stage>`

Runs a real deployed smoke test.

```sh
pnpm jawstack smoke dev
```

Expected behavior:

- Create a work request through the deployed API.
- Read it back.
- Verify activity was recorded.
- Verify an outbox/event path completed when observable.
- Report clear failures.

### `jawstack destroy <stage>`

Destroys a deployed stage.

```sh
pnpm jawstack destroy dev
```

Expected behavior:

- Delegate stack destruction to CDK.
- Make the dev teardown path obvious and documented.
- Avoid requiring manual console cleanup for normal generated resources.

## Package Scope

### `@jawstack/core`

Provides framework-neutral contracts and in-memory runtime behavior.

MVP capabilities:

- Resource definition API.
- Command definition API.
- Event envelope type.
- Auth context type.
- Command request and result types.
- Domain decision result types.
- Activity record type.
- Idempotency contract.
- In-memory repository and runtime adapters for tests.
- Registry and validation utilities.

### `@jawstack/aws-runtime`

Provides AWS runtime adapters.

MVP capabilities:

- DynamoDB item model.
- DynamoDB repository.
- Transactional unit of work.
- Outbox dispatcher.
- EventBridge publisher.
- Lambda command/query adapters.
- SQS worker adapter.
- Scheduler target adapter.

### `@jawstack/aws-cdk`

Provides AWS CDK constructs.

MVP public surface:

```ts
new JawStackResourceWorkflowApp(this, "WorkflowApp", {
  appName: "work-requests",
  stage: "dev",
  resources: [workRequestResource],
  costProfile,
  auth,
});
```

The construct creates:

- API Gateway.
- Lambda command/query handlers.
- DynamoDB table.
- DynamoDB stream.
- Outbox dispatcher Lambda.
- EventBridge bus.
- SQS worker queue.
- SQS dead-letter queue.
- Worker Lambda.
- EventBridge Scheduler example.
- CloudWatch alarms.
- Optional budget or cost alert resources.

The public docs should lead with one high-level construct in v0.1. Smaller constructs can exist internally if needed.

### `@jawstack/angular`

Provides resource workflow UI components, not a general design system.

MVP components:

```text
<js-app-shell>
<js-resource-list>
<js-resource-detail>
<js-resource-form>
<js-command-button>
<js-command-dialog>
<js-status-badge>
<js-activity-timeline>
<js-empty-state>
<js-error-panel>
```

The package should use Angular, CSS variables, and lightweight accessible components. It should avoid committing the MVP to PrimeNG, Angular Material, Tailwind, or a broad widget library.

### `@jawstack/cli`

Provides project-level commands:

- `doctor`
- `manifest`
- `deploy`
- `smoke`
- `destroy`

The CLI should be predictable, scriptable, and clear in CI.

### `create-jawstack`

Provides the project generator.

The generator should copy a starter app rather than requiring users to assemble packages manually.

## Auth Model

JawStack v0.1 defines a typed auth context and authorization hooks. It does not require a production identity provider.

Conceptual auth context:

```ts
export type AuthContext = {
  subject: string;
  displayName?: string;
  tenantId?: string;
  roles: string[];
  claims: Record<string, unknown>;
  mode: "dev" | "test" | "external";
};
```

MVP providers:

- `DevAuthProvider`
- `TestAuthProvider`
- `HeaderAuthProvider`

`DevAuthProvider` is for local/demo use. Deploying a non-local AWS stage with dev auth should fail `jawstack doctor` unless explicitly overridden.

Command roles are enforced by runtime authorization checks against `AuthContext.roles`. Angular components may use the same metadata to hide or disable actions, but UI behavior is not the security boundary.

Production adapters such as Cognito are future work.

## Cost Guardrails

JawStack provides cost guardrails and bounded-by-default infrastructure. It cannot guarantee a universal AWS spending cap.

The v0.1 cost contract:

- Generated infrastructure makes scaling limits explicit.
- Generated infrastructure fails checks when obvious runaway paths exist.
- Documentation distinguishes hard limits, soft limits, best-effort limits, and alert-only controls.
- `jawstack doctor` reports missing or unsafe guardrail configuration.

MVP guardrails:

- Every Lambda function has explicit timeout, memory, and concurrency settings.
- SQS event source mappings have maximum concurrency.
- Worker queues have DLQs and max receive counts.
- DynamoDB defaults to on-demand mode with explicit throughput guardrail settings where supported.
- EventBridge Scheduler retry policy and DLQ behavior are explicit.
- Possible event self-loops are detected heuristically.
- Budget or cost alert scaffolding is optional and clearly labeled as alert/control behavior, not a hard cap.
- Destroy commands and docs are part of the generated app.

Example config shape:

```ts
export default defineJawStackApp({
  appName: "work-requests",

  costProfile: {
    lambda: {
      defaultTimeoutSeconds: 10,
      maxTimeoutSeconds: 60,
      reservedConcurrency: 5,
    },

    queues: {
      defaultMaxConcurrency: 2,
      maxReceiveCount: 3,
      requireDlq: true,
    },

    dynamodb: {
      billingMode: "onDemand",
      maxReadRequestUnits: 100,
      maxWriteRequestUnits: 50,
    },

    eventBridge: {
      preventSelfTriggeringLoops: true,
      requireEventSchemaVersion: true,
    },
  },
});
```

## Local Development

JawStack should not try to fully emulate AWS locally.

The MVP local loop:

```sh
pnpm dev:web
pnpm dev:api
pnpm test
pnpm jawstack doctor
pnpm jawstack deploy dev
pnpm jawstack smoke dev
pnpm jawstack destroy dev
```

Expected behavior:

- `dev:web` runs Angular locally.
- `dev:api` runs a local Node HTTP adapter using the same command handlers.
- `test` runs unit and contract tests against in-memory adapters.
- `doctor` validates definitions and deploy readiness.
- `deploy`, `smoke`, and `destroy` exercise real AWS.

Initial local persistence:

- `InMemoryRepository`
- Optional `JsonFileRepository`

Out of scope for v0.1:

- LocalStack-first development.
- SAM-first local development.
- DynamoDB Local as the default path.
- Perfect local reproduction of EventBridge, SQS, IAM, or Scheduler.

## UI Scope

The generated Angular app should provide the first useful screen, not a landing page.

MVP UI screens:

- Work request list.
- Create work request form.
- Work request detail.
- Edit or command dialogs for assign, status change, comment, and close.
- Activity timeline.
- Empty states.
- Loading states.
- Error states.

The UI should be pragmatic and work-focused:

- Dense enough for repeated operational use.
- Clear status badges and command controls.
- Accessible form labels and button states.
- Responsive layout for common desktop and mobile widths.
- Minimal visual dependencies.

The UI does not need:

- A marketing homepage.
- A broad component catalog.
- Theme builder.
- Complex data grid.
- Drag-and-drop workflows.
- Real-time collaboration.

## Data and Persistence Scope

The MVP uses a single DynamoDB table with typed item kinds.

Conceptual item kinds:

```text
RESOURCE_STATE
ACTIVITY
OUTBOX_EVENT
IDEMPOTENCY_RECORD
PROJECTION_ITEM
```

Access patterns that must be supported:

- Load one resource state by resource type and resource ID.
- Create or update one resource state.
- Append activity for one resource.
- List activity for one resource.
- Store an outbox event.
- Mark an outbox event as published.
- Read idempotency result by command and key.
- List work requests for the resource list view.

The technical design should define exact keys and indexes. The PRD-level requirement is that the table model stays simple enough to explain and cheap enough for a generated starter app.

## Idempotency Model

Commands may include an idempotency key.

MVP expectations:

- Repeating a command with the same idempotency key and equivalent command payload returns the stored result.
- Repeating a command with the same idempotency key and a conflicting payload returns a clear idempotency conflict error.
- Idempotency records are committed in the same transaction as state, activity, and outbox records.
- Retention and cleanup policies may be simple in v0.1, but should be documented.

## Validation and Error Model

JawStack should produce structured, user-actionable errors.

Expected error categories:

- Resource definition errors.
- Command validation errors.
- Authorization errors.
- Idempotency conflicts.
- Missing resource errors.
- Invalid state transition errors.
- Runtime adapter errors.
- AWS configuration errors.
- Cost guardrail errors.
- Deployment readiness errors.

CLI findings should have stable codes, severity, location, impact, and suggested fix.

Runtime API errors should avoid leaking internal details while preserving enough structured information for the generated UI to show useful feedback.

## Security and Safety

JawStack reduces architecture and cost risk, but it does not make an application secure by itself.

MVP safety expectations:

- Dev auth is visibly unsafe for production and blocked from normal AWS deploys.
- Command authorization is enforced server-side.
- UI role checks are convenience behavior only.
- Command input is validated before domain decisions run.
- Worker handlers receive typed envelopes and must be idempotent.
- `jawstack doctor` checks for unsafe defaults before deploy.
- Generated IAM should use least-privilege intent where practical.
- Generated destroy paths are documented.
- Secrets management beyond basic configuration is future work unless required by the generated app.

## Output and CI Behavior

JawStack should work naturally in local terminals and CI.

Expected scripts in generated apps:

```json
{
  "scripts": {
    "build": "...",
    "typecheck": "...",
    "test": "...",
    "lint": "...",
    "dev:web": "...",
    "dev:api": "...",
    "jawstack": "jawstack"
  }
}
```

Expected CI checks:

- Install.
- Typecheck.
- Test.
- Build.
- Run `jawstack doctor` in non-deploy mode.

The generated app should not require AWS credentials for normal unit tests or local typechecking.

## MVP Acceptance Criteria

JawStack v0.1 is not ready for public release until all of the following are true:

- A new app can be generated with `npx create-jawstack`.
- The generated app installs cleanly.
- The generated app typechecks, tests, and builds.
- The generated Angular UI runs locally.
- The local API adapter runs locally.
- A user can create, assign, comment on, change status, and close a work request locally.
- Command handlers validate input and auth context.
- Command handlers commit state, activity, idempotency, projection, and outbox records through the runtime contract.
- Every successful state-changing command creates a typed event envelope.
- The activity timeline shows command activity.
- The AWS CDK app synthesizes.
- The dev stack deploys to AWS.
- The deployed API supports the Work Request command flow.
- Outbox events are published to EventBridge.
- At least one SQS worker consumes an event-driven message.
- At least one EventBridge Scheduler example exists.
- `jawstack smoke dev` verifies the deployed happy path.
- `jawstack destroy dev` removes generated dev resources.
- `jawstack doctor` catches missing cost guardrails.
- Lambda timeout, memory, and concurrency settings are explicit.
- SQS workers have maximum concurrency and DLQs.
- DynamoDB guardrail settings are explicit.
- Dev auth cannot be deployed accidentally.
- The README has a 5-minute quickstart.
- Core concepts are documented.
- Architecture and cost guardrail docs exist.
- GitHub Actions run typecheck, tests, build, and doctor.

## Success Metrics

For v0.1, success means:

- A developer can generate the app, run it locally, deploy it, smoke-test it, and destroy it by following the docs.
- The Work Requests example demonstrates a realistic workflow, not a toy CRUD table.
- The resource definition is visibly reused across runtime, infrastructure, CLI checks, and UI metadata.
- The outbox contract is test-covered and understandable.
- `jawstack doctor` catches real unsafe defaults with clear fixes.
- The generated app's AWS resources are bounded by explicit defaults.
- The project can be explained in one sentence without overclaiming.
- The implementation is narrow enough that future profiles and adapters can build on it.

## Future Directions

Potential post-MVP work:

- Productivity profile with richer workflow transitions.
- Comments as a reusable capability module.
- Notifications as a reusable capability module.
- Role and permission adapters.
- Cognito auth adapter.
- OpenAPI generation.
- Typed API client generation.
- Static docs generation from `jawstack manifest`.
- Angular route scaffolding.
- Aurora Serverless adapter.
- ECS Fargate worker adapter.
- More advanced projection strategies.
- Multi-resource applications.
- Multi-tenant SaaS patterns.
- Product profiles for content, analytics, e-commerce, fintech, IoT, healthcare, developer tools, and social/community apps.
- Plugin system after core extension points stabilize.
- Release automation with Changesets.
- Published docs site.

## Technical Design Inputs

The PRD sets the product boundary. The technical design should make the following implementation decisions explicitly:

- Exact DynamoDB partition key, sort key, and index design.
- Exact command decision result type.
- Exact projection update rules.
- Exact idempotency record shape and retention policy.
- Exact event schema versioning policy.
- Exact local HTTP API shape.
- Exact Angular component inputs and outputs.
- Exact CDK construct internals.
- Exact `jawstack doctor` finding code taxonomy.
- Exact release package build tooling.

Those decisions should preserve the MVP scope above rather than expanding the product surface.
