# JawStack Technical Design

## Overview

JawStack v0.1 is a TypeScript monorepo that produces a generated Angular and AWS resource workflow application.

The product contract is defined in `docs/prd.md`. This technical design describes the concrete implementation choices for the MVP:

- Resource definitions are executable TypeScript metadata.
- Command input validation is Zod-backed in v0.1.
- Current resource state is stored in DynamoDB and is the source of truth.
- Commands commit state, activity, idempotency, projections, and outbox events in one transactional unit of work.
- EventBridge publication happens only from committed outbox records.
- List projections are updated synchronously in the command transaction for v0.1.
- Local development uses in-memory and optional JSON-file adapters, not AWS emulation.
- The CDK package exposes one high-level public construct and uses smaller internal constructs.

The design deliberately optimizes for a narrow, testable kernel before broader product profiles, adapters, or code generation.

## Design Goals

- Keep the framework contract understandable from a small number of types.
- Make the local runtime and AWS runtime share the same command execution path.
- Keep generated apps ordinary TypeScript, Angular, and CDK projects.
- Preserve enough metadata for CLI validation, UI rendering, and future docs generation without parsing source files.
- Make command commits atomic across all records the command owns.
- Make async event publication retryable and idempotent for consumers.
- Keep the DynamoDB model simple enough to document.
- Keep cost guardrail defaults explicit in code and in synthesized infrastructure.

## Non-Goals

- Full event sourcing.
- Multi-table DynamoDB modeling in v0.1.
- Full local AWS emulation.
- Generic CRUD generator for arbitrary databases.
- Automatic migration or regeneration of edited user apps.
- Production identity provider implementation.
- Multi-tenant isolation guarantees beyond carrying `tenantId` in metadata.
- Strong event ordering guarantees.
- A broad UI design system.

## Runtime and Tooling Baseline

The repository uses a pnpm workspace.

Initial workspace shape:

```text
apps/
  docs/
  demo-work-requests/

packages/
  core/
  aws-runtime/
  aws-cdk/
  angular/
  cli/
  create-jawstack/

templates/
  angular-resource-workflow/

examples/
  work-requests/
```

Build decisions:

- Use TypeScript for all packages.
- Publish ESM packages with explicit `exports`.
- Use `tsup` for non-Angular package builds.
- Use Angular's library builder for `@jawstack/angular`.
- Use Vitest for non-Angular unit tests.
- Use Angular's test tooling only where component tests need it.
- Use pnpm workspace scripts instead of a task runner until build time or dependency ordering requires one.
- Use Changesets for versioning and release notes once packages are publishable.
- Set the generated app and package engine floor to Node.js 22 or newer for v0.1.

Root scripts:

```json
{
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  }
}
```

## Package Boundaries

### `@jawstack/core`

Owns framework-neutral contracts and local runtime behavior.

Exports:

- Resource definition API.
- State field metadata API.
- Command definition API.
- View metadata API.
- Event envelope and event draft types.
- Auth context types.
- Command request, decision, and result types.
- Activity record types.
- Projection write types.
- Idempotency types.
- Repository and unit-of-work interfaces.
- In-memory repository and unit-of-work implementation.
- Runtime command executor.
- Registry and manifest utilities.
- Finding and validator types used by `jawstack doctor`.

`@jawstack/core` must not import AWS SDK, CDK, Angular, or Node-only APIs except in clearly isolated local adapters.

### `@jawstack/aws-runtime`

Owns runtime adapters that run inside Lambda or AWS-facing local scripts.

Exports:

- DynamoDB item mappers.
- DynamoDB repository.
- DynamoDB transactional unit of work.
- EventBridge publisher.
- Outbox dispatcher.
- Outbox sweeper.
- Lambda HTTP adapter.
- SQS worker adapter.
- Scheduler target adapter.

`@jawstack/aws-runtime` depends on `@jawstack/core` and AWS SDK v3 packages.

### `@jawstack/aws-cdk`

Owns infrastructure synthesis.

Exports one public high-level construct in v0.1:

```ts
new JawStackResourceWorkflowApp(this, "WorkflowApp", {
  appName: "work-requests",
  stage: "dev",
  resources: [workRequestResource],
  costProfile,
  auth,
  entrypoints,
});
```

Internal constructs may be split by concern, but public docs should lead with the high-level construct.

### `@jawstack/angular`

Owns standalone Angular resource workflow components and a lightweight API client abstraction.

The package consumes resource metadata at runtime. It does not generate Angular files in v0.1.

### `@jawstack/cli`

Owns project commands:

- `doctor`
- `manifest`
- `deploy`
- `smoke`
- `destroy`

The CLI loads `jawstack.config.ts` and configured resource definitions.

### `create-jawstack`

Owns app generation.

The generator copies `templates/angular-resource-workflow`, applies package/app naming, and prints next steps. It does not attempt ongoing project upgrades.

## Schema and Metadata Strategy

JawStack v0.1 supports Zod as the only command input schema library.

Reasons:

- It gives immediate runtime validation.
- It preserves TypeScript inference for command inputs.
- It is familiar to the target user.
- It keeps the first implementation smaller than a provider-neutral schema adapter layer.

State metadata uses JawStack field definitions rather than raw Zod. State fields need UI labels, list/detail metadata, default values, and simple control hints that are awkward to infer reliably from arbitrary schemas.

The v0.1 state field API should cover:

- `field.string`
- `field.text`
- `field.enum`
- `field.boolean`
- `field.datetime`
- Optional values.
- Required values.
- Defaults.
- Labels.
- Descriptions.

Command input schemas are Zod values:

```ts
const assignWorkRequestInput = z.object({
  assigneeId: z.string().min(1),
});
```

State definitions are JawStack metadata:

```ts
const workRequestState = defineState({
  title: field.string({ required: true, label: "Title" }),
  description: field.text({ label: "Description" }),
  status: field.enum({
    label: "Status",
    values: ["open", "inReview", "blocked", "closed"],
    default: "open",
  }),
  assigneeId: field.string({ label: "Assignee" }),
});
```

Future schema adapters may support Valibot, JSON Schema, or Standard Schema, but v0.1 should not expose an unstable adapter abstraction unless implementation pressure proves it necessary.

## Core Types

### Auth Context

```ts
export type AuthMode = "dev" | "test" | "external";

export type AuthContext = {
  subject: string;
  displayName?: string;
  tenantId?: string;
  roles: string[];
  claims: Record<string, unknown>;
  mode: AuthMode;
};
```

### Event Envelope

```ts
export type JawStackEvent<TPayload = unknown> = {
  envelopeVersion: 1;
  eventId: string;
  eventType: string;
  schemaVersion: number;
  source: string;
  resourceType: string;
  resourceId: string;
  tenantId?: string;
  actor?: {
    subject: string;
    displayName?: string;
  };
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  payload: TPayload;
};
```

Event type format:

```text
<resourceName>.<pastTenseAction>
```

Examples:

```text
workRequest.created
workRequest.assigned
workRequest.statusChanged
workRequest.commentAdded
workRequest.closed
```

`schemaVersion` is a positive integer and starts at `1`. A breaking payload change requires a new schema version. Event type names should not include version suffixes in v0.1.

### Command Request

```ts
export type CommandRequest<TInput = unknown> = {
  requestId: string;
  correlationId: string;
  resourceType: string;
  resourceId?: string;
  commandName: string;
  input: TInput;
  idempotencyKey?: string;
  requestContext: unknown;
};
```

The HTTP adapter creates `requestId` and `correlationId` when the caller does not provide them.

### Command Context

```ts
export type CommandContext<TState, TInput> = {
  auth: AuthContext;
  input: TInput;
  previous: ResourceState<TState> | undefined;
  resourceId: string;
  requestId: string;
  correlationId: string;
  now: Date;
  ids: IdGenerator;
};
```

`previous` is `undefined` for create commands.

### Resource State

```ts
export type ResourceState<TState> = {
  resourceType: string;
  resourceId: string;
  version: number;
  state: TState;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  tenantId?: string;
};
```

Versions start at `1`. Updates increment by one.

### Command Decision

Domain command handlers return a full next-state decision.

```ts
export type CommandDecision<TState, TResponse = unknown> = {
  nextState: TState;
  activity: ActivityDraft[];
  events: EventDraft[];
  projections?: ProjectionWrite[];
  response: TResponse;
};
```

Rules:

- `nextState` is the complete next state, not a patch.
- State-changing commands must return at least one event.
- v0.1 generated commands return one event, but the core type allows multiple.
- Activity drafts are human-readable records for the resource timeline.
- Projection writes are explicit and committed in the same transaction.
- Long-running side effects do not belong in command decisions.

### Activity Draft

```ts
export type ActivityDraft = {
  activityType: string;
  title: string;
  summary?: string;
  data?: Record<string, unknown>;
};
```

The runtime fills:

- `activityId`
- `resourceType`
- `resourceId`
- `actor`
- `occurredAt`
- `correlationId`
- `causationId`

### Event Draft

```ts
export type EventDraft<TPayload = unknown> = {
  eventType: string;
  schemaVersion: number;
  payload: TPayload;
};
```

The runtime fills envelope fields.

### Projection Write

```ts
export type ProjectionWrite = {
  projectionName: string;
  itemId: string;
  sort: string;
  data: Record<string, unknown>;
  delete?: boolean;
};
```

For the Work Requests list view:

- `projectionName`: `workRequest.list`
- `itemId`: resource ID
- `sort`: reverse chronological updated timestamp plus resource ID
- `data`: title, status, assigneeId, updatedAt, resourceId

## Resource Definition Contract

`defineResource()` returns immutable metadata.

Conceptual type:

```ts
export type ResourceDefinition<TState = unknown> = {
  kind: "jawstack.resource";
  name: string;
  title: string;
  state: StateDefinition<TState>;
  commands: Record<string, CommandDefinition<TState, unknown, unknown>>;
  views: ResourceViews;
  workers?: WorkerDefinition[];
  schedules?: ScheduleDefinition[];
};
```

`defineCommand()` requires:

- `title`
- `input`
- `roles`
- `decide`
- `emits`

Conceptual type:

```ts
export type CommandDefinition<TState, TInput, TResponse> = {
  title: string;
  input: z.ZodType<TInput>;
  roles: string[];
  emits: Array<{ eventType: string; schemaVersion: number }>;
  create?: boolean;
  decide: (
    context: CommandContext<TState, TInput>,
  ) => CommandDecision<TState, TResponse> | Promise<CommandDecision<TState, TResponse>>;
};
```

`create: true` marks commands that create new resources. Non-create commands require `resourceId`.

`jawstack doctor` validates declared event metadata statically during config load. Core test helpers should validate that returned event drafts match declared `emits` metadata when command decisions are exercised.

## Command Execution Flow

The same executor is used by local HTTP and Lambda adapters.

Flow:

1. Parse route into `resourceType`, `resourceId`, and `commandName`.
2. Resolve `AuthContext`.
3. Load resource and command definitions from the registry.
4. Validate command input through Zod.
5. Enforce command roles against `AuthContext.roles`.
6. Compute command payload hash for idempotency when a key is present.
7. Check existing idempotency record.
8. Load current state unless the command is a create command.
9. Allocate resource ID for create commands.
10. Run the command decision function.
11. Build full activity records and event envelopes.
12. Build default list projection write unless the command opts out.
13. Commit all records through the unit of work.
14. Return the command response.

Idempotency pre-check:

- If no idempotency key is provided, continue normally.
- If a matching record exists with the same payload hash, return the stored response.
- If a matching record exists with a different payload hash, return an idempotency conflict.
- If no record exists, include the idempotency record in the transaction.

Race handling:

- If the transaction fails because the idempotency record already exists, re-read it and apply the same comparison logic.
- If the transaction fails because the resource version changed, return a conflict error.

## DynamoDB Table Design

The MVP uses one table per deployed JawStack app stage.

Table keys:

```text
PK string
SK string
```

Additional indexed attributes:

```text
GSI1PK string
GSI1SK string
```

`GSI1` is used only for operational outbox lookups in v0.1. List projections are queried by base table partition key to keep them easy to explain.

### Resource State Item

```text
PK = RES#<resourceType>#<resourceId>
SK = STATE
```

Attributes:

```ts
type ResourceStateItem = {
  itemKind: "RESOURCE_STATE";
  resourceType: string;
  resourceId: string;
  version: number;
  state: Record<string, unknown>;
  tenantId?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
};
```

Create condition:

```text
attribute_not_exists(PK)
```

Update condition:

```text
version = :expectedVersion
```

### Activity Item

```text
PK = RES#<resourceType>#<resourceId>
SK = ACT#<occurredAt>#<activityId>
```

Attributes:

```ts
type ActivityItem = {
  itemKind: "ACTIVITY";
  activityId: string;
  resourceType: string;
  resourceId: string;
  activityType: string;
  title: string;
  summary?: string;
  data?: Record<string, unknown>;
  actor?: {
    subject: string;
    displayName?: string;
  };
  tenantId?: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
};
```

Activity query:

```text
PK = RES#<resourceType>#<resourceId>
SK begins_with ACT#
```

### Outbox Event Item

```text
PK = OUTBOX#<eventId>
SK = EVENT
GSI1PK = OUTBOX#<status>
GSI1SK = <createdAt>#<eventId>
```

Attributes:

```ts
type OutboxEventItem = {
  itemKind: "OUTBOX_EVENT";
  eventId: string;
  status: "PENDING" | "PUBLISHED" | "FAILED";
  event: JawStackEvent;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  lastError?: string;
};
```

The command transaction writes outbox items with `status = "PENDING"`.

The dispatcher updates:

```text
status = PUBLISHED
publishedAt = now
attempts = attempts + 1
GSI1PK = OUTBOX#PUBLISHED
GSI1SK = <publishedAt>#<eventId>
```

If publishing fails in a retryable way, the Lambda invocation fails so DynamoDB Streams retries the batch. The sweeper covers records that remain `PENDING` after stream retry expiry or transient dispatcher failures.

### Idempotency Item

```text
PK = IDEMP#<resourceType>#<commandName>#<subject>
SK = <idempotencyKey>
```

Attributes:

```ts
type IdempotencyItem = {
  itemKind: "IDEMPOTENCY_RECORD";
  resourceType: string;
  commandName: string;
  subject: string;
  idempotencyKey: string;
  payloadHash: string;
  resourceId?: string;
  response: unknown;
  statusCode: number;
  createdAt: string;
  expiresAt: number;
};
```

Retention:

- Default TTL is 7 days.
- TTL is configurable in `jawstack.config.ts`.
- DynamoDB TTL is best-effort; stale records may remain after expiry and should still be treated normally until deleted.

Conflict rule:

- Same key and same payload hash returns stored response.
- Same key and different payload hash returns `idempotency.conflict`.

### Projection Item

```text
PK = PROJ#<resourceType>#<projectionName>
SK = <sort>#<itemId>
```

Attributes:

```ts
type ProjectionItem = {
  itemKind: "PROJECTION_ITEM";
  resourceType: string;
  projectionName: string;
  itemId: string;
  sort: string;
  data: Record<string, unknown>;
  resourceId: string;
  tenantId?: string;
  updatedAt: string;
};
```

For the Work Request list projection:

```text
PK = PROJ#workRequest#list
SK = <invertedUpdatedAt>#<resourceId>
```

Use an inverted timestamp string so the newest items sort first without a scan.

The technical implementation can use:

```text
9999999999999 - epochMillis
```

left-padded to 13 digits.

## Transactional Unit of Work

The unit of work interface lives in `@jawstack/core`.

```ts
export type CommitCommandInput = {
  resource: {
    resourceType: string;
    resourceId: string;
    expectedVersion?: number;
    next: ResourceState<unknown>;
    create: boolean;
  };
  activity: ActivityItem[];
  outbox: OutboxEventItem[];
  projections: ProjectionItem[];
  idempotency?: IdempotencyItem;
};

export interface CommandUnitOfWork {
  commit(input: CommitCommandInput): Promise<void>;
}
```

The DynamoDB implementation maps this to one `TransactWriteItems` call.

Transaction contents:

- One state `Put` for create or state `Update` for update.
- One or more activity `Put`s.
- One or more outbox `Put`s.
- Zero or more projection `Put` or `Delete` operations.
- Optional idempotency `Put`.

v0.1 generated commands must stay well below DynamoDB's transaction item limit. `jawstack doctor` warns when a command definition could exceed 80 transaction items based on static metadata.

## Projection Strategy

v0.1 uses synchronous projection writes for generated list views.

Reasons:

- The list view should reflect command results immediately after the command response.
- It keeps the MVP local runtime simple.
- It avoids requiring a projection worker before the main event/outbox path is proven.

Rules:

- Resource detail reads use `RESOURCE_STATE`.
- Activity timelines use `ACTIVITY`.
- Resource list views use `PROJECTION_ITEM`.
- Generated command helpers create a default projection write for the resource's default list view.
- Custom command decisions may override projection writes.
- Projection writes are part of the command transaction.

Async projections may be added later for cross-resource or expensive read models.

## Outbox Dispatch

The outbox dispatcher is triggered by DynamoDB Streams.

Dispatch flow:

1. Receive stream records.
2. Filter to `INSERT` or status-changing records where `itemKind = OUTBOX_EVENT` and `status = PENDING`.
3. Publish the event to EventBridge with:
   - `Source`: configured event source.
   - `DetailType`: event type.
   - `Detail`: full event envelope JSON.
   - `EventBusName`: generated bus name.
4. Update the outbox item to `PUBLISHED`.
5. Return success.

Duplicate behavior:

- If the dispatcher publishes successfully but fails before marking published, the stream retry may publish again.
- This is accepted in v0.1.
- Workers and consumers must use `eventId` for idempotency.

Outbox sweeper:

- A low-frequency scheduled Lambda queries `GSI1PK = OUTBOX#PENDING`.
- It considers only records older than 2 minutes.
- It publishes at most 10 records per run by default.
- It uses the same publisher and status update path as the stream dispatcher.
- Its reserved concurrency is `1`.

The sweeper exists for resilience, not throughput.

## Worker Runtime

v0.1 supports SQS to Lambda workers.

Worker definition:

```ts
export type WorkerDefinition<TEvent = unknown> = {
  name: string;
  eventTypes: string[];
  maxConcurrency: number;
  handler: (message: WorkerMessage<TEvent>) => Promise<void>;
};
```

Worker message:

```ts
export type WorkerMessage<TEvent = unknown> = {
  event: JawStackEvent<TEvent>;
  messageId: string;
  receivedAt: string;
};
```

CDK creates:

- EventBridge rule matching configured event types.
- SQS queue.
- SQS DLQ.
- Lambda worker.
- SQS event source mapping with maximum concurrency.

Idempotency:

- The generated worker adapter records processed `eventId`s in the same DynamoDB table.
- Worker idempotency item key:

```text
PK = WORKER#<workerName>#PROCESSED
SK = <eventId>
```

- Default TTL is 14 days.
- If a processed record exists, the worker skips the handler.
- If the handler succeeds, the processed record is written.
- This reduces duplicate handler execution, but it does not make external side effects atomic. Worker handlers must still tolerate retries.

## Schedule Runtime

Schedule definition:

```ts
export type ScheduleDefinition = {
  name: string;
  expression: string;
  targetCommand?: {
    resourceType: string;
    commandName: string;
    input: unknown;
  };
  targetHandler?: string;
  retry: {
    maxAttempts: number;
    maxEventAgeSeconds: number;
  };
};
```

v0.1 generated schedule:

- Name: `staleWorkRequestReminder`
- Expression: `rate(1 day)`
- Target: Scheduler Lambda handler.
- Behavior: finds stale open work requests and emits or logs a notification stub.

Scheduler targets must have explicit retry settings and a DLQ.

## HTTP API Design

Local and AWS HTTP adapters expose the same route shape.

Base routes:

```text
GET  /api/resources/:resourceType
GET  /api/resources/:resourceType/:resourceId
GET  /api/resources/:resourceType/:resourceId/activity
POST /api/resources/:resourceType/commands/:commandName
POST /api/resources/:resourceType/:resourceId/commands/:commandName
GET  /api/manifest
GET  /api/health
```

Create commands use:

```text
POST /api/resources/workRequest/commands/create
```

Resource commands use:

```text
POST /api/resources/workRequest/wr_123/commands/assign
```

Command request body:

```json
{
  "input": {},
  "idempotencyKey": "optional-client-key"
}
```

Success envelope:

```ts
export type ApiSuccess<T> = {
  ok: true;
  data: T;
  meta: {
    requestId: string;
    correlationId: string;
  };
};
```

Error envelope:

```ts
export type ApiError = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta: {
    requestId: string;
    correlationId: string;
  };
};
```

HTTP status mapping:

```text
400 command.validation
401 auth.missing
403 auth.forbidden
404 resource.not_found
409 resource.conflict
409 idempotency.conflict
422 command.rejected
500 runtime.internal
```

Auth headers for `HeaderAuthProvider`:

```text
x-jawstack-subject
x-jawstack-display-name
x-jawstack-roles
x-jawstack-tenant-id
```

Roles are comma-separated.

## Angular Design

`@jawstack/angular` exports standalone components and service providers.

Provider:

```ts
provideJawStack({
  apiBaseUrl: "/api",
  resources: [workRequestResource],
  auth: authStateProvider,
});
```

API client interface:

```ts
export interface JawStackApiClient {
  list(resourceType: string, options?: ListOptions): Promise<ResourceListResult>;
  get(resourceType: string, resourceId: string): Promise<ResourceDetailResult>;
  activity(resourceType: string, resourceId: string): Promise<ActivityResult>;
  command<TInput, TOutput>(
    request: ExecuteCommandRequest<TInput>,
  ): Promise<TOutput>;
}
```

Component contracts:

```ts
<js-app-shell
  [title]="title"
  [navItems]="navItems">
</js-app-shell>
```

```ts
<js-resource-list
  [resource]="workRequestResource"
  viewName="list"
  (selectResource)="openResource($event)"
  (createResource)="openCreateDialog()">
</js-resource-list>
```

```ts
<js-resource-detail
  [resource]="workRequestResource"
  [resourceId]="resourceId">
</js-resource-detail>
```

```ts
<js-resource-form
  [resource]="workRequestResource"
  [commandName]="commandName"
  [initialValue]="initialValue"
  (submitted)="execute($event)"
  (cancelled)="close()">
</js-resource-form>
```

```ts
<js-command-button
  [resource]="workRequestResource"
  [resourceId]="resourceId"
  commandName="close">
</js-command-button>
```

```ts
<js-command-dialog
  [resource]="workRequestResource"
  [resourceId]="resourceId"
  [commandName]="commandName"
  [open]="open"
  (closed)="open = false">
</js-command-dialog>
```

```ts
<js-status-badge [value]="status"></js-status-badge>
```

```ts
<js-activity-timeline
  [resource]="workRequestResource"
  [resourceId]="resourceId">
</js-activity-timeline>
```

```ts
<js-empty-state
  [title]="title"
  [message]="message"
  [actionLabel]="actionLabel"
  (action)="handleAction()">
</js-empty-state>
```

```ts
<js-error-panel [error]="error"></js-error-panel>
```

Generated app routing:

```text
/work-requests
/work-requests/new
/work-requests/:id
```

The Angular package should render usable defaults from resource metadata. The generated app may wrap or replace components freely.

## CDK Design

Public construct:

```ts
export interface JawStackResourceWorkflowAppProps {
  appName: string;
  stage: string;
  resources: ResourceDefinition[];
  costProfile: CostProfile;
  auth: AuthConfig;
  entrypoints: {
    apiHandler: string;
    outboxHandler: string;
    workerHandlers: Record<string, string>;
    schedulerHandlers: Record<string, string>;
    frontendDist?: string;
  };
  removalPolicy?: "destroy" | "retain";
}
```

Internal constructs:

- `JawStackTableConstruct`
- `JawStackEventBusConstruct`
- `JawStackApiConstruct`
- `JawStackOutboxConstruct`
- `JawStackWorkerConstruct`
- `JawStackSchedulerConstruct`
- `JawStackFrontendConstruct`
- `JawStackGuardrailsConstruct`

Resources created:

- DynamoDB table with streams and TTL.
- EventBridge custom bus.
- HTTP API Gateway.
- API Lambda.
- Outbox dispatcher Lambda.
- Outbox sweeper Lambda and schedule.
- SQS queues and DLQs for workers.
- Worker Lambdas and event source mappings.
- EventBridge rules routing events to worker queues.
- EventBridge Scheduler schedules and DLQs.
- CloudWatch log groups with explicit retention.
- CloudWatch alarms for DLQs, Lambda errors, and throttles.
- Optional AWS Budget or cost alert resources.
- Optional S3 and CloudFront frontend hosting when `frontendDist` is provided.

Default infrastructure policies:

- `dev` removal policy defaults to destroy.
- Non-dev removal policy defaults to retain for stateful resources.
- DynamoDB billing mode defaults to on-demand.
- Point-in-time recovery defaults to off for `dev`, configurable for non-dev.
- Lambda functions always set timeout, memory, reserved concurrency, and log retention.
- SQS queues always set DLQ, max receive count, and visibility timeout.
- SQS visibility timeout must be at least six times worker Lambda timeout.
- Scheduler targets always set retry policy and DLQ.

## Cost Profile Type

```ts
export type CostProfile = {
  lambda: {
    defaultTimeoutSeconds: number;
    maxTimeoutSeconds: number;
    defaultMemoryMb: number;
    reservedConcurrency: number;
  };
  queues: {
    defaultMaxConcurrency: number;
    maxReceiveCount: number;
    requireDlq: boolean;
  };
  dynamodb: {
    billingMode: "onDemand";
    maxReadRequestUnits?: number;
    maxWriteRequestUnits?: number;
    pointInTimeRecovery?: boolean;
  };
  eventBridge: {
    preventSelfTriggeringLoops: boolean;
    requireEventSchemaVersion: boolean;
  };
  budgets?: {
    monthlyWarningUsd: number;
    monthlyStoplightUsd?: number;
    email?: string;
  };
};
```

`monthlyStoplightUsd` must be documented as alert/control behavior, not a guaranteed account stop.

## Configuration Loading

Default config lookup:

```text
jawstack.config.ts
jawstack.config.mts
jawstack.config.js
jawstack.config.mjs
```

Config shape:

```ts
export type JawStackConfig = {
  appName: string;
  stage?: string;
  resources: ResourceDefinition[];
  auth: AuthConfig;
  costProfile: CostProfile;
  aws?: {
    region?: string;
    profile?: string;
  };
};
```

The CLI loads config with an ESM/TypeScript runtime loader. Config loading is code execution and should be documented as such.

`jawstack manifest` serializes a safe metadata subset. It must not include command handler functions, secrets, or raw executable config.

## CLI Findings

Finding type:

```ts
export type FindingSeverity = "error" | "warning" | "info";

export type Finding = {
  id: string;
  severity: FindingSeverity;
  title: string;
  message: string;
  location?: {
    file?: string;
    path?: string;
    resource?: string;
    command?: string;
  };
  impact?: string;
  fix?: string;
};
```

Initial finding IDs:

```text
config.missing
config.invalid
config.stage.missing
resource.name.invalid
resource.name.duplicate
resource.state.missing
command.name.invalid
command.name.duplicate
command.handler.missing
command.input.invalid
command.roles.empty
event.type.invalid
event.schema-version.missing
auth.provider.missing
auth.dev.deploy-blocked
cost.lambda.timeout.missing
cost.lambda.timeout.too-high
cost.lambda.memory.missing
cost.lambda.concurrency.missing
cost.queue.dlq.missing
cost.queue.max-concurrency.missing
cost.queue.max-receive-count.missing
cost.dynamodb.billing-mode.invalid
cost.dynamodb.throughput-guardrail.missing
cost.scheduler.retry.missing
cost.scheduler.dlq.missing
event.loop.suspicious
aws.region.missing
aws.credentials.unavailable
manifest.serialize.failed
```

Doctor modes:

- Default mode validates local project shape and non-AWS deploy readiness.
- `--stage <stage>` includes stage-specific config.
- `--deploy` checks AWS region and credentials.
- `--json` outputs stable machine-readable findings.
- `--strict` treats warnings as errors.

Exit codes:

```text
0 no blocking findings
1 blocking findings
2 usage or config loading error
```

## Manifest Design

`jawstack manifest` outputs:

```ts
export type JawStackManifest = {
  schemaVersion: 1;
  appName: string;
  stage: string;
  generatedAt: string;
  resources: Array<{
    name: string;
    title: string;
    fields: Array<{
      name: string;
      kind: string;
      required: boolean;
      label?: string;
    }>;
    commands: Array<{
      name: string;
      title: string;
      roles: string[];
      emits: Array<{ eventType: string; schemaVersion: number }>;
      create: boolean;
    }>;
    views: unknown;
    workers: Array<{ name: string; eventTypes: string[] }>;
    schedules: Array<{ name: string; expression: string }>;
  }>;
  auth: {
    mode: AuthMode;
    provider: string;
  };
  costProfile: CostProfile;
};
```

The manifest is deterministic except for `generatedAt`. `--stable` omits `generatedAt` for tests and generated docs.

## Local Runtime

`@jawstack/core` provides:

- `InMemoryRepository`
- `InMemoryUnitOfWork`
- `LocalCommandRuntime`

The generated app provides:

- Local Node HTTP server.
- Dev auth provider.
- In-memory persistence by default.
- Optional JSON file persistence through an explicit flag.

Local API command:

```sh
pnpm dev:api
```

Optional persistence:

```sh
pnpm dev:api -- --store .jawstack/local-store.json
```

The JSON file adapter is intended for manual demos only. Tests should use in-memory adapters.

## Testing Strategy

Core tests:

- Resource definition validation.
- Command input validation.
- Role authorization.
- Command decisions.
- Idempotency pre-check behavior.
- In-memory unit-of-work behavior.
- API envelope mapping.
- Manifest serialization.
- Doctor finding generation.

AWS runtime tests:

- DynamoDB key mapping.
- Transaction item construction.
- Idempotency conflict handling.
- Outbox dispatcher filtering.
- EventBridge publish request mapping.
- Worker idempotency behavior.

CDK tests:

- Construct synthesizes.
- Table has streams and TTL.
- Lambdas have timeout, memory, reserved concurrency, and log retention.
- Queues have DLQs.
- Event source mappings have max concurrency.
- Scheduler targets have retry policy and DLQ.
- Dev auth deploy guard is represented in validations.

Angular tests:

- Components render from resource metadata.
- Command forms emit expected input.
- List and detail components call API client.
- Error and loading states render.
- Role metadata disables or hides unavailable commands.

Generated app tests:

- Work Request command flow.
- Activity timeline.
- Local API happy path.
- `jawstack doctor` clean result.

AWS smoke test:

- Deploy dev stack.
- Create work request.
- Read detail.
- Read activity.
- Wait for outbox publication signal.
- Confirm worker side effect marker.
- Destroy dev stack.

## Error Codes

Runtime error codes:

```text
command.validation
command.rejected
auth.missing
auth.forbidden
resource.not_found
resource.conflict
resource.invalid_state
idempotency.conflict
runtime.internal
runtime.unavailable
```

Errors returned to clients use the API error envelope. Internal stack traces are logged, not returned.

## Security Design

v0.1 security posture:

- Auth provider is explicit.
- Dev auth is blocked for normal AWS deploys.
- Server-side command authorization is mandatory.
- UI authorization is advisory only.
- Command input is treated as untrusted and parsed before decisions.
- IAM permissions are scoped by construct role where practical.
- API Lambda can read and write only the app table and required logs.
- Outbox Lambda can read stream records, update outbox items, and put events to the app bus.
- Worker Lambdas can consume their queues and write worker idempotency records.
- Scheduler Lambdas have only the permissions required for their generated example.

Secrets:

- v0.1 generated app should not require application secrets.
- Future adapters should use AWS Secrets Manager or SSM Parameter Store, not environment literals.

## Implementation Order Constraints

The implementation plan should preserve this dependency order:

1. Repository scaffold.
2. `@jawstack/core` metadata and runtime contracts.
3. In-memory command runtime and Work Request tests.
4. CLI config loading, manifest, and doctor baseline.
5. DynamoDB item model and transactional unit of work.
6. Outbox dispatcher and publisher.
7. CDK construct synthesis.
8. SQS worker and scheduler support.
9. Angular resource shell.
10. Generated app template.
11. Deploy, smoke, and destroy commands.
12. Docs and release polish.

CDK and Angular work should not start before the core command/runtime contract is covered by tests.

## Release Design

Before public npm release:

- All packages build from the workspace.
- Package exports are explicit.
- The generated app uses published package names even during local development through workspace references.
- Changesets controls package versions and changelogs.
- CI runs install, typecheck, test, build, and doctor.
- Release workflow publishes packages in dependency order.
- `create-jawstack` template references compatible `@jawstack/*` versions.

Release channels:

- `0.0.x` for kernel proof and private dogfooding.
- `0.1.0` for first public Work Requests MVP.

No package should be marked stable before the generated app can deploy, smoke-test, and destroy a dev AWS stage from docs.
