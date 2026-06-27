> **JAWS 0.1 is a state-first, event-emitting resource workflow framework. It is not event sourcing. It uses DynamoDB as the source of truth for current resource state, appends activity/event records for auditability, writes a minimal transactional outbox, and publishes those outbox events to EventBridge. Auth is a typed pluggable context with a dev/demo stub in 0.1. The public cost promise is “cost guardrails,” not “hard cost caps.” `defineResource()` produces runtime/CDK/UI metadata first, not a full codegen universe. Generated apps are owned by the user. Public naming should be JawStack / `@jawstack/*`, with JAWS as the informal origin story.**

That gives you a coherent 0.1 implementation target.

---

# JAWS 0.1 architecture decisions

## 1. State model

Codex is right: **do not call this event sourcing**.

JAWS 0.1 should be:

> **Current state + append-only activity log + outbox-published domain events + derived projections.**

The source of truth is the current resource state in DynamoDB. Events are durable audit/activity records and integration messages. Projections are derived read models. You may be able to rebuild some projections from activity records later, but that should not be the correctness model in 0.1.

That means this is **not**:

```text
Event stream → fold events → current state
```

It is:

```text
Command → validate → authorize → update current state → append activity/event → publish integration event
```

The Product Classes document actually supports this MVP choice. The Business Productivity class emphasizes task states, workflow, roles, activity logs, notifications, automation, and scheduled jobs; the Developer Tools class emphasizes CLI/API/docs cohesion, clear errors, observability, and trust. JAWS 0.1 sits exactly at that intersection: a dev tool that generates a workflow/productivity-style vertical slice.

For 0.1, I would use a **single DynamoDB table** with typed item kinds:

```text
RESOURCE_STATE
ACTIVITY
OUTBOX_EVENT
IDEMPOTENCY_RECORD
PROJECTION_ITEM
```

Example shape:

```text
PK                                  SK
RESOURCE#workRequest#wr_123          STATE
RESOURCE#workRequest#wr_123          ACTIVITY#2026-06-20T18:42:00Z#evt_abc
OUTBOX#evt_abc                       EVENT
IDEMPOTENCY#createWorkRequest#key1   RESULT
PROJECTION#workRequestList           ITEM#wr_123
```

For 0.1, I would not overfit the single-table design. The point is not to prove DynamoDB wizardry. The point is to have one bounded, cheap, deployable storage model.

---

## 2. Command transaction semantics

This is the one place where I would be stricter than Codex.

I would **not** do:

```text
write DynamoDB state
write activity
publish EventBridge event
return
```

That is too easy to get into a half-failed state. If the DynamoDB write succeeds and the EventBridge publish fails, the system has changed but downstream consumers never hear about it.

Instead, I would use a **minimal DynamoDB outbox from day one**.

The command handler should perform one transactional write:

```text
1. Update current resource state
2. Append activity/event record
3. Put outbox event record
4. Put/update idempotency record
```

DynamoDB `TransactWriteItems` supports all-or-nothing grouped writes, which makes it suitable for this small atomic state/activity/outbox boundary. AWS documents that a `TransactWriteItems` operation can group up to 100 write actions and complete them atomically. ([AWS Documentation][1])

Then a tiny dispatcher publishes outbox records to EventBridge:

```text
DynamoDB Stream → outbox dispatcher Lambda → EventBridge PutEvents → mark outbox event published
```

DynamoDB Streams can trigger Lambda functions on table mutations, which is enough for the outbox dispatcher. AWS also warns that stream consumers should stay short-lived and that Lambda retries failed batches until success or record expiry, so the dispatcher should do only one job: publish outbox events and update outbox status. ([AWS Documentation][2])

The 0.1 guarantee should be explicit:

```text
A successful command means:
- resource state was committed;
- activity was recorded;
- an outbox event was committed.

It does not mean:
- every async consumer has run;
- every projection has caught up;
- every notification has been sent.
```

Event delivery semantics should be:

```text
At-least-once publication.
At-least-once consumption.
Consumers must be idempotent.
Ordering is best-effort per resource unless explicitly constrained later.
```

That is professional enough without turning 0.1 into Kafka-in-miniature.

### Command flow

```ts
export async function executeCommand(command: CommandRequest) {
  const auth = await authProvider.resolve(command.requestContext);

  const definition = registry.getCommand(command.resource, command.commandName);

  definition.authorize(auth);
  const input = definition.validate(command.input);

  const previous = await repository.getState(command.resourceId);

  const decision = definition.decide({
    auth,
    input,
    previous,
    now: clock.now(),
  });

  await unitOfWork.commit({
    stateChange: decision.stateChange,
    activity: decision.activity,
    outboxEvent: decision.event,
    idempotencyKey: command.idempotencyKey,
  });

  return decision.response;
}
```

The important architectural rule:

> **Only committed outbox records are eligible for EventBridge publication. Command handlers do not directly publish domain events.**

That should be in `vision.md`.

---

## 3. Auth and identity

For 0.1, I would **not** integrate Cognito as a required default.

Cognito is plausible later, but it introduces user pools, app clients, callback URLs, hosted UI decisions, JWT verification, local login UX, password policies, and environment-specific setup. That is too much ceremony for the first useful slice.

The 0.1 decision should be:

> **JAWS core defines a typed auth context and authorization hooks. The generated demo app uses a dev/demo auth provider. Production auth providers are adapters.**

Something like:

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

Then the DSL can keep this:

```ts
commands: {
  assign: command().input(AssignWorkRequest).requiresRole("manager").emits("workRequest.assigned");
}
```

But `.requiresRole("manager")` means:

```text
The runtime command adapter enforces this against AuthContext.roles.
The Angular UI may use this to hide/disable controls.
The auth provider that fills AuthContext is pluggable.
```

For 0.1, provide:

```text
DevAuthProvider
TestAuthProvider
HeaderAuthProvider
```

Do **not** pretend this is production security. Make the deployment guard explicit:

```ts
auth: {
  provider: "dev",
  allowInAws: false
}
```

Then `jaws doctor` or CDK synth should fail if someone tries to deploy a non-local stage with dev auth enabled unless they explicitly override it.

That is the right compromise: auth-compatible, not auth-dominated.

---

## 4. Cost semantics

Codex is exactly right here: do not promise “hard cost caps.”

Use this language instead:

> **JAWS provides cost guardrails and bounded-by-default infrastructure. It cannot guarantee a universal AWS spending cap.**

That distinction matters. AWS gives you useful controls, but not a magical account-level circuit breaker.

For JAWS 0.1, the cost contract should be:

```text
JAWS-generated infrastructure must make scaling limits explicit.
JAWS-generated infrastructure must fail checks when obvious runaway paths exist.
JAWS must document which limits are hard, soft, best-effort, or alert-only.
```

### Concrete 0.1 guardrails

| Area                  | 0.1 rule                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------- |
| Lambda                | Every function has explicit timeout, memory, and reserved concurrency defaults.              |
| SQS consumers         | Every event source mapping has maximum concurrency.                                          |
| SQS queues            | Every worker queue has a DLQ and max receive count.                                          |
| DynamoDB              | On-demand mode by default, with optional max read/write throughput targets.                  |
| EventBridge Scheduler | Retry policy and DLQ are explicit for generated schedules.                                   |
| Event loops           | `jaws doctor` detects suspicious self-triggering event paths.                                |
| Budgets               | Generated optional Budget/alert scaffolding, clearly labeled as alert/control, not hard cap. |
| Destruction           | Every generated app has a documented `destroy dev` path.                                     |

AWS Lambda SQS event source mappings support maximum concurrency, and AWS specifically says maximum concurrency should be coordinated with function reserved concurrency to avoid throttling. ([AWS Documentation][3]) Lambda timeout is configurable up to 900 seconds, so JAWS should deliberately set shorter defaults for API and worker functions instead of inheriting ambiguous defaults. ([AWS Documentation][4]) DynamoDB max on-demand throughput helps bound table-level usage and cost, but AWS documents it as best-effort rather than a guaranteed ceiling. ([AWS Documentation][5]) EventBridge Scheduler supports recurring and one-time schedules, retry limits, retention settings, and DLQ configuration, so generated schedules should expose those values instead of hiding them. ([AWS Documentation][6]) AWS Budgets actions can apply IAM/SCP policies or target EC2/RDS resources, but that is not the same thing as a universal serverless kill switch. ([AWS Documentation][7])

So I would replace “cost-capped” with one of:

```text
cost-guarded
bounded-by-default
runaway-resistant
cost-aware serverless
```

My favorite public phrasing:

> **JawStack helps you build event-driven AWS applications with typed contracts, predictable architecture, and cost guardrails.**

---

## 5. Resource DSL compilation target

For 0.1, `defineResource()` should **not** generate a whole application by magic.

It should produce a typed metadata object consumed by runtime, CDK, and Angular helpers.

Decision:

> **The 0.1 DSL is executable TypeScript metadata, not a separate language and not an AST/codegen system.**

That means this:

```ts
export const WorkRequest = defineResource({
  name: "workRequest",

  state: objectState({
    title: stringField({ required: true, label: "Title" }),
    description: stringField({ label: "Description" }),
    status: enumField({
      values: ["open", "inReview", "blocked", "closed"],
      default: "open",
    }),
    assigneeId: stringField({ label: "Assignee" }),
  }),

  commands: {
    create: defineCommand({
      input: CreateWorkRequestInput,
      roles: ["user"],
      decide: createWorkRequest,
    }),

    assign: defineCommand({
      input: AssignWorkRequestInput,
      roles: ["manager"],
      decide: assignWorkRequest,
    }),

    close: defineCommand({
      input: CloseWorkRequestInput,
      roles: ["manager"],
      decide: closeWorkRequest,
    }),
  },

  views: {
    list: defineListView({
      title: "Work Requests",
      columns: ["title", "status", "assigneeId", "updatedAt"],
    }),

    detail: defineDetailView({
      titleField: "title",
      sections: ["summary", "activity"],
    }),
  },
});
```

This definition should be consumed by:

```text
@jawstack/core          Types, validation contracts, command/event definitions
@jawstack/aws-runtime   Command router, repository, outbox, EventBridge publisher
@jawstack/aws-cdk       Tables, APIs, Lambdas, queues, bus, scheduler, alarms
@jawstack/angular       Generic resource list/detail/form/timeline components
@jawstack/cli           doctor, manifest, project scaffolding
```

Avoid heavy codegen in 0.1.

Reason: once you generate lots of files, you inherit a migration problem. If users edit generated files, future upgrades become messy. If you regenerate over user files, the framework feels dangerous.

So for 0.1:

```text
create-jawstack copies a starter app.
defineResource declares metadata.
Runtime/CDK/UI packages consume metadata.
No repeated regeneration required.
```

Later, add codegen for:

```text
OpenAPI
typed API client
static docs/reference
Angular route scaffolds
migration helpers
```

But not yet.

Angular supports creating publishable libraries, public API surfaces, and schematics when generation becomes useful; that gives you a future path without forcing schematics into the first release. ([Angular][8])

---

## 6. Local development

The local development rule should be:

> **JAWS does not emulate AWS. JAWS gives you a fast local contract loop and a cheap real AWS smoke loop.**

Minimum 0.1 loop:

```bash
pnpm dev:web
pnpm dev:api
pnpm test
pnpm jaws doctor
pnpm jaws deploy dev
pnpm jaws smoke dev
pnpm jaws destroy dev
```

Where:

```text
dev:web
  Runs Angular locally.

dev:api
  Runs a local Node HTTP adapter using the same command handlers.

test
  Runs unit and contract tests against in-memory adapters.

jaws doctor
  Validates resource definitions, cost guardrails, env config, auth mode, and AWS deploy readiness.

jaws deploy dev
  Deploys the real AWS stack.

jaws smoke dev
  Runs one or more real commands against the deployed API and verifies state/activity/event flow.

jaws destroy dev
  Tears down the dev stack.
```

Local persistence should start with:

```text
InMemoryRepository
JsonFileRepository
```

Not LocalStack. Not SAM-first. Not DynamoDB Local-first.

Those can be optional later, but the first release should avoid becoming a local AWS simulation project.

---

## 7. Generated app ownership

Codex is right again: generated apps should be owned by the user.

Decision:

> **`create-jawstack` creates a normal TypeScript/Angular/CDK app. Users can edit it freely. JawStack packages provide primitives, not a forever-managed black box.**

That means no promise like:

```bash
jawstack upgrade-my-whole-app-without-conflicts
```

At least not in 0.1.

The generated app should contain:

```text
src/
  app/
    resources/
      work-request.resource.ts
    features/
      work-requests/
    shared/

infra/
  app.ts
  stacks/
    jawstack-app-stack.ts

api/
  handlers/
  runtime.ts

jaws.config.ts
```

Framework-owned:

```text
@jawstack/core
@jawstack/aws-runtime
@jawstack/aws-cdk
@jawstack/angular
@jawstack/cli
```

User-owned:

```text
resource definitions
command decision functions
Angular customization
CDK app composition
environment config
styling
domain logic
```

This is the right OSS posture. You are not trying to be Vercel. You are shipping a serious starter/framework hybrid.

---

## 8. Naming

I would treat this as settled:

```text
Public product name: JawStack
Package scope: @jawstack/*
CLI package: create-jawstack
CLI binary: jawstack
Internal nickname: JAWS
```

So:

```bash
npm create jawstack@latest my-app
# or
npx create-jawstack my-app
```

Avoid making `jaws` the primary public binary. The JAWS screen reader collision is real enough that `JawStack` is cleaner, more searchable, and more specific.

Package names:

```text
@jawstack/core
@jawstack/aws-runtime
@jawstack/aws-cdk
@jawstack/angular
@jawstack/cli
create-jawstack
```

The repo can still say:

> JawStack began as “JAWS,” a TypeScript/AWS framework concept.

But public positioning should be `JawStack`.

---

# The 0.1 implementation spec I would hand to Codex

Here is the practical spec.

## JawStack 0.1 product definition

**JawStack 0.1 generates and supports one evented resource workflow application.**

The generated app demonstrates a `WorkRequest` resource with:

```text
create
assign
changeStatus
comment
close
list
detail
activity timeline
scheduled stale-item reminder
queued async notification stub
```

The purpose is not the domain. The purpose is proving the architecture.

---

## Core concepts

```text
Resource
  A domain object with current state.

Command
  A validated, authorized intent to change resource state.

Event
  A fact emitted after a successful state change.

Activity
  Human-readable audit record shown in the UI.

Outbox Event
  Durable event record waiting to be published to EventBridge.

Projection
  Derived read model used for list/detail/query UX.

Worker
  Async consumer of events or queue messages.

Schedule
  EventBridge Scheduler-driven recurring or one-time trigger.

Cost Guardrail
  Explicit scaling, retry, timeout, and alert configuration.
```

---

## Runtime contract

A command handler must:

```text
1. Resolve AuthContext.
2. Validate command input.
3. Load current resource state.
4. Run domain decision function.
5. Commit state/activity/outbox/idempotency in one DynamoDB transaction.
6. Return command result.
```

A command handler must not:

```text
- publish directly to EventBridge;
- perform long-running async work;
- call unrelated downstream services synchronously unless explicitly allowed;
- rely on projected read models for invariants.
```

An outbox dispatcher must:

```text
1. Observe committed OUTBOX_EVENT records.
2. Publish the event envelope to EventBridge.
3. Mark the outbox record published.
4. Retry safely.
5. Avoid duplicate side effects through event IDs.
```

A worker must:

```text
1. Accept a typed event/message envelope.
2. Be idempotent by eventId/messageId.
3. Have max concurrency.
4. Have a DLQ.
5. Have explicit retry behavior.
```

---

## Event envelope

Use one standard envelope immediately:

```ts
export type JawStackEvent<TPayload = unknown> = {
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

Example:

```ts
{
  eventId: "evt_01J...",
  eventType: "workRequest.assigned",
  schemaVersion: 1,
  source: "jawstack.workRequests",
  resourceType: "workRequest",
  resourceId: "wr_123",
  actor: {
    subject: "user_123",
    displayName: "Jeremy"
  },
  correlationId: "corr_456",
  causationId: "cmd_789",
  occurredAt: "2026-06-20T18:42:00.000Z",
  payload: {
    assigneeId: "user_456"
  }
}
```

---

## Resource definition contract

`defineResource()` returns metadata.

It should be usable by:

```text
runtime command router
CDK construct factory
Angular resource shell
doctor command
manifest/doc generator
```

It should not require parsing source files.

Example:

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

---

## CDK contract

`@jawstack/aws-cdk` should expose one high-level construct in 0.1:

```ts
new JawStackResourceWorkflowApp(this, "WorkflowApp", {
  appName: "work-requests",
  stage: "dev",
  resources: [workRequestResource],
  costProfile,
  auth,
});
```

That construct creates:

```text
API Gateway
Lambda command/query handlers
DynamoDB table
DynamoDB stream
Outbox dispatcher Lambda
EventBridge bus
SQS worker queue
SQS DLQ
Worker Lambda
EventBridge Scheduler example
CloudWatch alarms
optional Budget/Cost alert resources
```

Do not expose 47 constructs in the public docs yet. Internally, sure. Publicly, one construct.

---

## Angular contract

`@jawstack/angular` should not be a generic UI library.

It should provide resource-workflow components:

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

The generated Work Requests app should use those components but allow normal Angular customization.

The library should avoid PrimeNG, Material, Tailwind, or any heavyweight component dependency in 0.1. Use basic Angular, CSS variables, and simple accessible components.

---

## CLI contract

`create-jawstack`:

```bash
npx create-jawstack my-app
```

Creates the app.

`jawstack doctor`:

```bash
pnpm jawstack doctor
```

Validates:

```text
resource definitions
missing command handlers
missing event schema versions
missing auth provider
unsafe dev auth in AWS stage
Lambda timeout settings
Lambda reserved concurrency
SQS max concurrency
SQS DLQs
DynamoDB throughput guardrails
Scheduler retry/DLQ config
possible EventBridge self-loop
required AWS env vars/profile
```

`jawstack manifest`:

```bash
pnpm jawstack manifest
```

Outputs a JSON description of resources, commands, events, views, and workers. This becomes the basis for docs/OpenAPI/codegen later.

---

# What should be in `vision.md` now

I would add a section like this.

```md
## JawStack 0.1 Contract

JawStack 0.1 is not an event sourcing framework.

JawStack applications use DynamoDB to store current resource state. Commands mutate current state and append activity/event records. Activity records are durable audit records. Outbox records are durable integration events waiting for publication. Projections are derived read models and are not the source of truth.

A successful command means the state change, activity record, outbox event, and idempotency record were committed. It does not mean downstream workers, projections, notifications, or integrations have completed.

Command handlers do not publish directly to EventBridge. They commit outbox records. A dispatcher publishes committed outbox events to EventBridge.

JawStack provides cost guardrails, not a universal hard cost cap. Generated infrastructure uses explicit Lambda timeouts, reserved concurrency, SQS maximum concurrency, DLQs, retry policies, DynamoDB throughput settings, alarms, and optional AWS Budget alerts/actions where appropriate.

Auth in 0.1 is a typed AuthContext with pluggable providers. The generated demo uses a development auth provider. Production identity providers such as Cognito are adapters, not core requirements.

The resource DSL is executable TypeScript metadata consumed by runtime, CDK, Angular, and CLI helpers. 0.1 avoids heavy code generation. Generated apps are owned by users and may be edited freely.

The public project name is JawStack. JAWS remains the origin/codename.
```

---

# The one place I’d push back on Codex

Codex said:

> “I’d define interfaces as outbox-compatible, but implement a simple path first with clear caveats.”

I would not do that.

For a normal app, fine. For **this** app, no. The event bus is one of the defining architectural principles. If the first version knowingly has unreliable event publication, then the core story is compromised.

A minimal outbox is not that much extra surface area:

```text
one item type
one stream-triggered Lambda
one publisher
one status update
one retry/sweeper path
```

And it gives JawStack a much stronger claim:

> **Commands commit state and durable events atomically. EventBridge publication is asynchronous and retryable.**

That is a real framework contract.

---

# Recommended first build order

I would have Codex implement in this sequence:

```text
1. Monorepo skeleton
2. @jawstack/core event envelope + command/resource types
3. In-memory runtime adapter
4. WorkRequest resource in pure local tests
5. DynamoDB repository with state/activity/idempotency/outbox item types
6. DynamoDB transactional command commit
7. CDK table/API/Lambda construct
8. Outbox dispatcher via DynamoDB Streams → EventBridge
9. SQS worker + DLQ + max concurrency
10. EventBridge Scheduler example
11. Angular resource shell
12. create-jawstack starter
13. jawstack doctor
14. GitHub Pages docs
```

That order keeps you from starting with CDK sprawl or UI polish before the actual framework contract exists.

---

# Final position

The MVP should be:

> **JawStack 0.1: a TypeScript/Angular/AWS framework starter for evented resource workflow apps, using DynamoDB current state, transactional activity/outbox records, EventBridge publication, SQS workers, Scheduler jobs, and explicit cost guardrails.**

Not event sourcing.
Not universal product generation.
Not Cognito-first.
Not hard cost caps.
Not a giant code generator.
Not a component library clone.

One resource. One workflow. One deployable app. Strong contracts. Clear docs. Expand from there.

[1]: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html "Amazon DynamoDB Transactions: How it works - Amazon DynamoDB"
[2]: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.Lambda.html "DynamoDB Streams and AWS Lambda triggers - Amazon DynamoDB"
[3]: https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-scaling.html "Configuring scaling behavior for SQS event source mappings - AWS Lambda"
[4]: https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html "Configure Lambda function timeout - AWS Lambda"
[5]: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode-max-throughput.html "DynamoDB maximum throughput for on-demand tables - Amazon DynamoDB"
[6]: https://docs.aws.amazon.com/eventbridge/latest/userguide/using-eventbridge-scheduler.html "Amazon EventBridge Scheduler - Amazon EventBridge"
[7]: https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-controls.html "Configuring budget actions - AWS Cost Management"
[8]: https://angular.dev/tools/libraries/creating-libraries "Creating Libraries • Angular"
