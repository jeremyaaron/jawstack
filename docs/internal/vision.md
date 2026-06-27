## My take: JAWS 0.1 should be a **cost-capped evented resource starter**, not “the framework for every product class” yet.

The taxonomy document is still useful: it breaks digital products into classes like Content & Media, Analytics & Data, Business Productivity, Consumer Utilities, Developer Tools, E-Commerce, Fintech, Gaming, Healthcare/Wellness, IoT, and Social/Community. But the first JAWS release should not try to implement all those classes. It should implement the one horizontal primitive almost all of them need:

**A user-facing resource with state, commands, events, async work, scheduled work, audit/activity history, and a basic Angular UI.**

That gives you a real framework nucleus instead of a pile of CDK snippets.

JAWS itself is best understood as a **Developer Tools & Platforms** product. That means the MVP should optimize for CLI experience, documentation, clear errors, predictable project structure, observability, and trust—not breadth of app types. Your generated applications can target product classes later, but JAWS the product is a dev tool first.

---

## The MVP I would build

Call it something like:

**JAWS Resource Workflow Starter**

The first release should let someone run one command and get a deployable, low/no-fixed-cost AWS app:

```bash
npx create-jaws-app my-workflow-app
cd my-workflow-app
pnpm install
pnpm jaws doctor
pnpm jaws deploy dev
```

The generated app should include one complete vertical slice:

**“Work Requests” / “Cases” / “Tasks”**

A user can create a request, update its status, assign it, add comments, see an activity timeline, and trigger a background handler when something changes.

That sounds mundane, but it is the right mundane. A case/request/task primitive maps cleanly to business productivity, admin tools, support tools, dev tools, moderation queues, health intake workflows, fintech reviews, content review, IoT alerts, and internal dashboards. It is the “hello world” of serious software.

The MVP should generate:

| Layer       | 0.1 scope                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Frontend    | Angular SPA shell, resource list, create/edit form, detail page, activity timeline, status badge, empty/error/loading states |
| API         | API Gateway/Lambda handlers for commands and queries                                                                         |
| Persistence | DynamoDB table for resource state, activity/event records, idempotency records                                               |
| Event spine | EventBridge bus with typed resource events                                                                                   |
| Async work  | SQS queue + Lambda worker + DLQ                                                                                              |
| Scheduling  | EventBridge Scheduler hook for reminders/SLA-style examples                                                                  |
| Infra       | CDK app with one stage, tags, alarms, cost guardrails, destroy path                                                          |
| DX          | CLI, docs site, example app, typed contracts, local tests, deployment guide                                                  |

AWS CDK is the right IaC base for this because CDK constructs are the basic composable building blocks of CDK apps, and TypeScript is a fully supported stable CDK language. ([AWS Documentation][1])

---

## The first “real” JAWS abstraction

The core abstraction should be **Resource + Command + Event + Projection**, not “Lambda function” or “DynamoDB table.”

Something like this:

```ts
export const WorkRequest = defineResource({
  name: "workRequest",

  schema: z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    status: z.enum(["open", "inReview", "blocked", "closed"]),
    assigneeId: z.string().optional(),
  }),

  commands: {
    create: command().input(CreateWorkRequest).emits("workRequest.created"),

    assign: command()
      .input(AssignWorkRequest)
      .requiresRole("manager")
      .emits("workRequest.assigned"),

    close: command().input(CloseWorkRequest).requiresRole("manager").emits("workRequest.closed"),
  },

  views: {
    list: resourceListView({
      columns: ["title", "status", "assigneeId", "updatedAt"],
    }),

    detail: resourceDetailView({
      sections: ["summary", "activity", "comments"],
    }),
  },

  jobs: {
    onCreated: onEvent("workRequest.created")
      .queue({ maxConcurrency: 2 })
      .handle(sendNotificationStub),

    staleReminder: onSchedule("rate(1 day)").handle(findStaleOpenRequests),
  },
});
```

The user should not have to think first in terms of Lambda, SQS, EventBridge, DynamoDB indexes, Angular forms, or IAM. They should think:

**“I have a resource. These are the commands. These are the events. These are the views. These are the background behaviors.”**

JAWS then materializes the boring architecture.

---

## The killer differentiator: **cost guardrails as framework behavior**

This is where JAWS can be meaningfully different from “yet another serverless starter.” Your fear of surprise AWS cost is not a side concern; it should be a design principle.

Every generated JAWS app should ship with a `jaws.cost.ts` or `jaws.config.ts` that refuses unsafe defaults.

Example:

```ts
export default defineJawsApp({
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

    budgets: {
      monthlyWarningUsd: 5,
      monthlyStoplightUsd: 20,
    },
  },
});
```

The framework should make unsafe things explicit. For example:

```bash
jaws doctor
```

Should report:

```text
✓ All Lambda functions have explicit timeouts
✓ All queue consumers have maximum concurrency
✓ All queues have DLQs
✓ No EventBridge rule targets its source command handler
✓ DynamoDB max on-demand throughput configured
✓ Budget/anomaly alert module enabled
```

This matters because Lambda can run up to 900 seconds, but unbounded fan-out and queue consumers are the real cost/scaling risk. AWS supports reserved concurrency for Lambda functions, and SQS event source mappings also support maximum concurrency so a queue cannot freely consume all available Lambda concurrency. ([AWS Documentation][2]) DynamoDB on-demand is a good default for low/variable traffic, and AWS now supports maximum on-demand throughput settings to help bound table-level usage and cost. ([AWS Documentation][3])

That gives JAWS a clear public promise:

> **Build event-driven AWS apps with sane defaults, typed contracts, and hard cost guardrails.**

That is much sharper than “cloud-native TypeScript framework.”

---

## What I would exclude from 0.1

A professional MVP is not a small version of everything. It is one thing done completely.

I would **not** include these in 0.1:

| Exclude                         | Why                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Aurora Serverless adapter       | Relational support drags in migrations, connection management, transactions, VPC decisions, and ORM politics. |
| ECS worker adapter              | Important later, but Lambda + SQS proves the worker abstraction first.                                        |
| Multiple product-class profiles | The taxonomy should guide future modules, not dominate the first release.                                     |
| Full UI component library       | Build only the components needed by the generated app.                                                        |
| Athena/data lake analytics      | You already identified this as a cost-risk zone; keep it out of core.                                         |
| Multi-tenant SaaS               | Valuable later, too much for 0.1.                                                                             |
| AI agents/tool execution        | Your `tool-call-contract` work can influence the style, but don’t let AI features hijack the framework MVP.   |
| Plugin ecosystem                | Not until your core extension points stabilize.                                                               |

Aurora Serverless v2 is more attractive than it used to be because supported versions can scale down to 0 ACUs and pause when inactive, but it still introduces a different operational model than DynamoDB and should be a later adapter, not part of the first useful slice. ([AWS Documentation][4])

---

## Cloneable template or packages? The answer is both, but with one primary entry point.

I would not make users assemble ten packages by hand. That feels academic and annoying.

The primary product should be:

```bash
npx create-jaws-app
```

Under the hood, you maintain a monorepo with a small number of published packages:

```text
jaws/
  apps/
    docs/
    demo-work-requests/

  packages/
    core/
    aws-runtime/
    aws-cdk/
    angular/
    cli/

  templates/
    angular-resource-workflow/

  examples/
    work-requests/
```

Initial package split:

| Package                              | Purpose                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `@jawstack/core`                     | Resource definitions, commands, events, envelopes, validation, result/error types |
| `@jawstack/aws-runtime`              | EventBridge publisher, DynamoDB repositories, SQS worker helpers, Lambda adapters |
| `@jawstack/aws-cdk`                  | CDK constructs for bus/table/API/worker/scheduler/cost alarms                     |
| `@jawstack/angular`                  | Resource shell components: list, detail, status, timeline, form scaffolds         |
| `create-jaws-app` or `@jawstack/cli` | Project generator, doctor checks, deploy helpers, codegen                         |

That is granular enough to be clean, but not so granular that users drown in packages.

For repo tooling, pnpm workspaces are a good fit because pnpm has built-in monorepo support, and Changesets is specifically designed around monorepo-friendly versioning and changelog generation. ([pnpm][5])

One naming note: **JAWS** is already a very established name in software because JAWS is a long-running screen reader product. That does not mean you cannot keep JAWS as your internal codename, but for public npm/GitHub positioning I would seriously consider a more specific package scope like `@jawstack/*`, `@jaws-cloud/*`, or `@jaws-ts/*`. ([Vispero][6])

---

## The Angular component library should be pattern-first, not widget-first.

Given your recent pain with Angular upgrades and PrimeNG, I agree with the instinct to have a lightweight internal component library. But do not start by building generic buttons, tables, modals, dropdowns, calendars, and form controls. That is how you accidentally become PrimeNG-lite.

Start with **JAWS-specific product pattern components**:

```text
<jaws-app-shell>
<jaws-resource-list>
<jaws-resource-detail>
<jaws-command-bar>
<jaws-status-badge>
<jaws-activity-timeline>
<jaws-empty-state>
<jaws-error-panel>
<jaws-confirm-command-dialog>
```

Angular’s own documentation frames libraries as appropriate when you have a solution you need to reuse across applications, and standalone components reduce the old NgModule burden. ([Angular][7]) So for 0.1, I would keep `@jawstack/angular` narrow: only the components needed for the generated Work Requests app, built with CSS variables and minimal dependencies.

The principle should be:

> JAWS UI is not a design system. It is a set of reusable UX patterns for evented resource applications.

That keeps the scope under control.

---

## Event bus design: keep the bus central, but not magical.

Your event bus instinct is right, with one caveat: the event bus should be the **system spine**, not the system brain.

A good JAWS rule:

> Commands mutate state. Mutations emit facts. Facts flow through the bus. Consumers are idempotent.

Every event should have a standard envelope:

```ts
type JawsEvent<TPayload> = {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  source: string;
  subject: string;
  tenantId?: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  payload: TPayload;
};
```

For the MVP, every command handler should:

1. Validate input.
2. Check authorization.
3. Check idempotency.
4. Write resource state.
5. Write activity/event record.
6. Publish typed event.
7. Return a standard response.

Later, you can harden this into an outbox pattern. In 0.1, you can still design the interfaces so the eventual outbox implementation does not break consumers.

EventBridge Scheduler belongs in the framework as the standard schedule primitive because it supports one-time and recurring schedules and can invoke targets with retry/retention controls. ([AWS Documentation][8])

---

## Long-running work: define the abstraction now, implement only Lambda first.

You are right that some workloads need ECS tasks or queue workers when Lambda timeouts are an issue. Standard Lambda timeout maxes out at 15 minutes, and SQS visibility timeout has its own operational ceiling, so JAWS should not pretend Lambda is the answer to every worker problem. ([AWS Documentation][2])

But 0.1 should only implement:

```ts
worker("sendNotification")
  .fromQueue("workRequestEvents")
  .maxConcurrency(2)
  .handler(sendNotification);
```

Under the hood in 0.1: SQS → Lambda.

Later:

```ts
worker("videoTranscode").fromQueue("mediaJobs").runOnEcsFargate({
  maxTasks: 2,
  cpu: 1024,
  memoryMiB: 2048,
});
```

The abstraction is `Worker`. The first runtime is Lambda. ECS comes after the concept is proven.

---

## Product taxonomy should become “profiles,” not core code.

Your old taxonomy should evolve into a mapping layer:

```text
Product Class → Capability Modules → UX Patterns → AWS Architecture Defaults
```

For example:

| Product class         | First-class capabilities later                                      |
| --------------------- | ------------------------------------------------------------------- |
| Business Productivity | workflow, tasks, comments, roles, notifications, activity logs      |
| Content & Media       | catalog, upload, playback progress, feed, recommendation hooks      |
| Analytics & Data      | event ingestion, metric snapshots, dashboards, alerts, exports      |
| Social & Community    | profiles, posts, comments, moderation, reactions, reputation        |
| E-Commerce            | catalog, cart, order, payment state, fulfillment events             |
| Fintech               | transaction ledger, approvals, audit trails, secure confirmations   |
| IoT                   | device registry, command dispatch, telemetry snapshots, alert rules |
| Healthcare/Wellness   | intake, tracking, reminders, consent, sensitive-data access logs    |
| Developer Tools       | API keys, usage logs, deployments, docs, environments, webhooks     |

This lets you say:

```bash
jaws add profile productivity
jaws add capability comments
jaws add capability notifications
```

But that is not 0.1.

For 0.1, ship one profile implicitly:

```text
resource-workflow
```

That profile is the seed crystal.

---

## Local development: don’t try to perfectly emulate AWS.

This is a trap. Local AWS emulation becomes its own product.

For 0.1, I would support three local modes:

```bash
pnpm jaws dev:web       # Angular only
pnpm jaws dev:api       # local Lambda adapter with in-memory/Dynamo-local-ish repo
pnpm jaws test          # pure unit/contract tests
```

Then have one real AWS smoke deploy path:

```bash
pnpm jaws deploy dev
pnpm jaws smoke dev
pnpm jaws destroy dev
```

AWS SAM can run Lambda functions locally through a local HTTP server, and SAM supports TypeScript Lambda builds through esbuild, but I would use that as an optional smoke/debug path—not as the conceptual foundation of the framework. ([AWS Documentation][9])

Your framework should make real AWS deploys cheap, bounded, and easy to destroy. That is more valuable than pretending your laptop is AWS.

---

## Professional 0.1 definition of done

I would not publish 0.1 until all of this is true:

```text
✓ New app can be generated from CLI
✓ Generated app installs cleanly
✓ Generated app has Angular UI
✓ User can create/update/close a Work Request
✓ Every command emits a typed event
✓ Activity timeline shows emitted events
✓ SQS worker consumes at least one event type
✓ EventBridge Scheduler example exists
✓ CDK synth/deploy/destroy works
✓ jaws doctor catches missing cost guardrails
✓ Lambda timeouts and concurrency are explicit
✓ SQS workers have max concurrency and DLQ
✓ DynamoDB max on-demand throughput is configurable
✓ README has 5-minute quickstart
✓ Docs site is published to GitHub Pages
✓ API reference generated
✓ Architecture diagram included
✓ Cost model page included
✓ Roadmap page included
✓ GitHub Actions run typecheck/test/build
✓ Changesets or equivalent release process exists
```

AWS Budgets and Cost Anomaly Detection should be part of the recommended setup or an optional generated module; AWS Budget actions can apply IAM/SCP-style controls or target EC2/RDS resources, and Cost Anomaly Detection can monitor deployed spend patterns and alert on anomalies. ([AWS Documentation][10])

---

## Suggested release ladder

### `0.0.1` — “kernel proof”

Publish quietly.

Includes:

```text
@jawstack/core
@jawstack/aws-cdk
@jawstack/aws-runtime
```

Capabilities:

```text
defineEvent()
defineResource()
defineCommand()
standard event envelope
standard API response envelope
DynamoDB resource repository
EventBridge publisher
CDK construct for table + bus + queue + worker
```

No big marketing push. This is for dogfooding release hygiene.

---

### `0.1.0` — first public release

Publicly useful.

Includes:

```text
create-jaws-app
@jawstack/angular
example Work Requests app
docs site
cost guardrails
GitHub Actions
deployment guide
```

Positioning:

> **JAWS is a TypeScript framework for building cost-capped, event-driven AWS applications with Angular and CDK.**

Not:

> “JAWS lets you build every kind of digital product.”

The latter is the long-term vision. The former is the first thing people can understand.

---

### `0.2.0` — first product profile

Add:

```text
productivity profile
comments
notifications
basic roles
workflow transitions
```

This is where your old `WorkflowModule` idea can come back: versioned workflow definitions, transition guards, approvals, SLA reminders, and event-driven state changes.

---

### `0.3.0` — second persistence/runtime path

Pick one:

```text
Aurora Serverless adapter
```

or:

```text
ECS Fargate worker adapter
```

Not both.

Given your cost-control thesis, I would probably add **ECS workers before Aurora**, because long-running async work is a more natural extension of the event/queue architecture than relational persistence.

---

## The repo should tell a story.

Your GitHub repo should not look like a pile of experiments. It should look like a product.

Top-level README structure:

```md
# JAWS

Cost-capped event-driven TypeScript apps on AWS.

## Why JAWS?

- Angular frontend
- AWS CDK infrastructure
- API Gateway + Lambda APIs
- DynamoDB resource state
- EventBridge event spine
- SQS workers
- Scheduler support
- Built-in cost guardrails

## Quickstart

## Generated Architecture

## Core Concepts

- Resource
- Command
- Event
- Worker
- Schedule
- Projection
- Cost Profile

## Example: Work Requests

## Cost Safety

## Roadmap
```

Docs site structure:

```text
docs/
  getting-started/
    quickstart
    deploy-to-aws
    destroy-your-stack

  concepts/
    resource
    command
    event
    worker
    schedule
    cost-profile

  guides/
    adding-a-resource
    adding-a-worker
    adding-a-scheduled-job
    adding-an-angular-view

  reference/
    core-api
    cdk-constructs
    cli

  architecture/
    event-spine
    persistence
    cost-guardrails
    security-model

  roadmap/
    product-profiles
    aurora-adapter
    ecs-workers
```

---

## The simplest starting sequence

I would build in this order:

1. **Monorepo skeleton** with pnpm, TypeScript, linting, tests, Changesets, GitHub Actions, docs app.
2. **`@jawstack/core`** with event envelope, command result types, resource definition API, validation.
3. **`@jawstack/aws-cdk`** with `JawsResourceWorkflowConstruct`.
4. **`@jawstack/aws-runtime`** with Lambda command handler, DynamoDB repository, EventBridge publisher, SQS worker adapter.
5. **Example Work Requests backend** with create/update/close commands and events.
6. **Angular shell** with resource list/detail/activity timeline.
7. **`jaws doctor`** cost/safety validator.
8. **`create-jaws-app`** generator.
9. **Docs site + public 0.1 release.**

That gives you a usable product, a public artifact, and a foundation you can keep expanding without rethinking everything every two weeks.

The key scope discipline is this:

> **JAWS 0.1 should prove that one evented resource can be generated, deployed, used, observed, and cost-bounded. Everything else is later.**

[1]: https://docs.aws.amazon.com/cdk/v2/guide/constructs.html?utm_source=chatgpt.com "AWS CDK Constructs - AWS Cloud Development Kit ..."
[2]: https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html?utm_source=chatgpt.com "Configure Lambda function timeout"
[3]: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html?utm_source=chatgpt.com "What is Amazon DynamoDB? - Amazon DynamoDB"
[4]: https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html?utm_source=chatgpt.com "Scaling to Zero ACUs with automatic pause and resume for ..."
[5]: https://pnpm.io/workspaces?utm_source=chatgpt.com "Workspace"
[6]: https://vispero.com/jaws-screen-reader-software/?utm_source=chatgpt.com "JAWS Screen Reader Software | Enabling Digital ..."
[7]: https://angular.dev/tools/libraries/creating-libraries?utm_source=chatgpt.com "Creating Libraries"
[8]: https://docs.aws.amazon.com/eventbridge/latest/userguide/using-eventbridge-scheduler.html?utm_source=chatgpt.com "Amazon EventBridge Scheduler"
[9]: https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-cli-command-reference-sam-local-start-api.html?utm_source=chatgpt.com "sam local start-api - AWS Serverless Application Model"
[10]: https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-controls.html?utm_source=chatgpt.com "Configuring budget actions - AWS Cost Management"
