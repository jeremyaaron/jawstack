# JawStack Implementation Plan

## Purpose

This plan breaks the PRD and technical design into implementation phases sized for one normal code-review-commit cycle. Each phase should leave the repository in a working state with tests passing and a coherent diff.

The phases are intentionally smaller than product milestones. The PRD describes the v0.1 product, the technical design describes the architecture, and this plan describes the practical build order.

## Phase Sizing

A phase should usually fit in one focused implementation pass when:

- It changes a small number of architectural surfaces.
- It has clear acceptance criteria.
- It can be reviewed without understanding unrelated future phases.
- It leaves the workspace buildable, testable, or more complete in an obvious way.
- It avoids combining core contracts, AWS runtime, CDK, Angular, and template work in one diff.

If a phase starts producing broad incidental refactors, split it before continuing.

## Phase 0: Repository Scaffold

Goal: turn the blank repository into a working pnpm TypeScript monorepo skeleton.

Scope:

- Create root `package.json`.
- Configure pnpm workspaces.
- Add root TypeScript, Prettier, ESLint, and Vitest configuration.
- Add workspace package folders:
  - `packages/core`
  - `packages/aws-runtime`
  - `packages/aws-cdk`
  - `packages/angular`
  - `packages/cli`
  - `packages/create-jawstack`
- Add placeholder source entrypoints for each package.
- Add root scripts for build, typecheck, test, lint, format, and format check.
- Add `.gitignore`.
- Add README stub with product name and development commands.
- Add GitHub Actions workflow for install, typecheck, test, and build.

Out of scope:

- Real framework APIs.
- Angular workspace setup.
- CDK constructs.
- CLI command behavior beyond placeholder help.
- Template app generation.

Acceptance criteria:

- `pnpm install` succeeds.
- `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
- Every package has an explicit name, version, entrypoint, and exports map.
- CI uses the same verification commands as local development.

## Phase 1: Core Metadata API

Goal: establish the public `@jawstack/core` metadata API for resources, state, commands, views, workers, and schedules.

Scope:

- Implement `defineResource`.
- Implement `defineState`.
- Implement state field helpers:
  - `field.string`
  - `field.text`
  - `field.enum`
  - `field.boolean`
  - `field.datetime`
- Implement `defineCommand`.
- Implement `defineListView`.
- Implement `defineDetailView`.
- Add worker and schedule definition types.
- Add structural validation for names, titles, fields, command roles, and event declarations.
- Export public TypeScript types.
- Add unit tests for valid metadata and malformed definitions.

Out of scope:

- Command execution.
- Zod input parsing.
- Registry-wide duplicate checks.
- Manifest generation.
- AWS or Angular behavior.

Acceptance criteria:

- A sample `WorkRequest` resource can be declared in a unit test.
- Invalid local definitions fail with clear programmer-facing errors.
- Resource metadata is immutable or treated as readonly by public types.
- Package exports expose the public API from `@jawstack/core`.

## Phase 2: Core Runtime Types and Command Executor

Goal: implement the framework-neutral command runtime contract.

Scope:

- Add core types for:
  - `AuthContext`
  - `JawStackEvent`
  - `CommandRequest`
  - `CommandContext`
  - `ResourceState`
  - `CommandDecision`
  - `ActivityDraft`
  - `EventDraft`
  - `ProjectionWrite`
  - API success and error envelopes
- Implement Zod-backed command input validation.
- Implement role authorization against `AuthContext.roles`.
- Implement command execution flow up to the repository/unit-of-work boundary.
- Generate event envelopes and activity records from drafts.
- Add stable runtime error codes.
- Add unit tests for validation, authorization, missing resources, create commands, update commands, activity generation, and event envelope generation.

Out of scope:

- In-memory repository implementation.
- Idempotency persistence.
- DynamoDB persistence.
- HTTP adapter.
- CLI config loading.

Acceptance criteria:

- The executor can run against mocked repository and unit-of-work interfaces.
- Zod defaults are reflected in parsed command inputs.
- Unauthorized commands return structured errors.
- Successful commands produce state, activity, and outbox-ready event envelopes.
- Tests cover both create and update command paths.

## Phase 3: In-Memory Persistence and Work Request Kernel

Goal: prove the core runtime with a real `WorkRequest` resource and local in-memory persistence.

Scope:

- Implement `InMemoryRepository`.
- Implement `InMemoryUnitOfWork`.
- Implement resource state versioning.
- Implement synchronous projection writes in memory.
- Implement idempotency pre-check and conflict behavior in memory.
- Add Work Request input schemas and decision functions:
  - `create`
  - `assign`
  - `changeStatus`
  - `comment`
  - `close`
- Add Work Request resource metadata.
- Add core tests for the full Work Request command flow.
- Add activity and list projection tests.

Out of scope:

- HTTP server.
- CLI.
- DynamoDB.
- Angular.
- CDK.

Acceptance criteria:

- Tests can create, assign, change status, comment, and close a work request.
- Repeating a command with the same idempotency key and payload returns the stored response.
- Repeating with the same key and a different payload returns `idempotency.conflict`.
- Resource version conflicts produce a structured conflict error.
- List projection updates reflect the latest Work Request state.

## Phase 4: Manifest and Registry

Goal: add registry-wide validation and deterministic manifest generation.

Scope:

- Implement `ResourceRegistry`.
- Detect duplicate resource names.
- Detect duplicate command names within a resource.
- Validate event type formats and schema versions.
- Validate list/detail view references to known state fields.
- Implement `createManifest`.
- Add stable manifest output with optional `generatedAt`.
- Add tests for registry validation and manifest serialization.

Out of scope:

- CLI config loading.
- Doctor reporters.
- OpenAPI or docs generation.
- Source-file scanning.

Acceptance criteria:

- A valid Work Request resource produces a manifest matching an inline snapshot.
- Duplicate or invalid definitions produce structured findings.
- `--stable`-style manifest behavior can omit timestamps for tests.
- Manifest serialization excludes functions and executable config.

## Phase 5: CLI Shell, Config Loading, and Reporters

Goal: establish the `jawstack` CLI structure and config-loading foundation.

Scope:

- Implement `jawstack` binary in `@jawstack/cli`.
- Add commands:
  - `doctor`
  - `manifest`
  - `deploy`
  - `smoke`
  - `destroy`
- Add placeholder behavior for deploy, smoke, and destroy.
- Implement default config lookup:
  - `jawstack.config.ts`
  - `jawstack.config.mts`
  - `jawstack.config.js`
  - `jawstack.config.mjs`
- Add `defineJawStackApp`.
- Load TypeScript/ESM config files.
- Implement human and JSON reporters for findings.
- Add CLI exit code handling.
- Add fixture tests for config loading and reporter behavior.

Out of scope:

- Real CDK deployment.
- Real smoke tests.
- AWS credential checks.
- Doctor's full guardrail matrix.
- Project generator.

Acceptance criteria:

- `jawstack --help` and command help render without throwing.
- CLI can load a TypeScript config from a fixture project.
- Missing or invalid config exits with code `2`.
- `jawstack manifest --stable` prints deterministic JSON.
- Reporter tests cover errors, warnings, info findings, and JSON output.

## Phase 6: Doctor Baseline

Goal: make `jawstack doctor` useful before AWS runtime exists.

Scope:

- Wire config loading, registry validation, manifest creation, and cost profile validation into `doctor`.
- Implement finding IDs for:
  - invalid config
  - duplicate resources
  - invalid command definitions
  - invalid event declarations
  - missing auth provider
  - dev auth deploy block
  - missing cost profile sections
  - missing queue, Lambda, DynamoDB, and Scheduler guardrail defaults
- Add `--stage`, `--deploy`, `--json`, and `--strict`.
- Add fixture tests for clean config, invalid config, strict mode, dev auth deploy block, and missing guardrails.

Out of scope:

- AWS credential checks beyond placeholder structure.
- CDK synthesis inspection.
- Event loop graph analysis beyond metadata heuristics.
- Deploy command implementation.

Acceptance criteria:

- `jawstack doctor` exits `0` for a valid local Work Request config.
- Blocking findings exit `1`.
- Usage/config-load failures exit `2`.
- `--strict` treats warnings as blocking.
- Findings include stable IDs, severity, location, impact, and fix text.

## Phase 7: Local HTTP API Adapter

Goal: expose the core runtime through the local HTTP routes defined in the technical design.

Scope:

- Implement the generic local Node HTTP adapter in `@jawstack/core`.
- Keep the executable dev server wiring in the generated app or CLI layer.
- Add routes:
  - `GET /api/resources/:resourceType`
  - `GET /api/resources/:resourceType/:resourceId`
  - `GET /api/resources/:resourceType/:resourceId/activity`
  - `POST /api/resources/:resourceType/commands/:commandName`
  - `POST /api/resources/:resourceType/:resourceId/commands/:commandName`
  - `GET /api/manifest`
  - `GET /api/health`
- Implement `DevAuthProvider`, `TestAuthProvider`, and `HeaderAuthProvider`.
- Implement API success and error envelopes.
- Add integration tests against the local HTTP server.

Out of scope:

- Angular UI.
- Lambda/API Gateway adapter.
- JSON file persistence unless it is needed for manual testing.
- Production auth.

Acceptance criteria:

- Local HTTP tests can run the full Work Request command flow.
- API errors map to the documented status codes and error envelopes.
- Header auth roles are enforced server-side.
- `GET /api/manifest` returns safe manifest JSON.

## Phase 8: DynamoDB Item Model

Goal: implement AWS persistence mapping without deploying infrastructure yet.

Scope:

- Add AWS SDK v3 dependencies to `@jawstack/aws-runtime`.
- Implement DynamoDB key builders for:
  - resource state
  - activity
  - outbox
  - idempotency
  - projection
  - worker idempotency
- Implement item mappers to and from core types.
- Implement transaction item builders.
- Implement deterministic inverted timestamp sort key helper.
- Add unit tests for all key shapes and item conversions.

Out of scope:

- Live DynamoDB calls.
- Lambda adapters.
- Outbox dispatcher.
- CDK table.

Acceptance criteria:

- All key formats match `docs/technical-design.md`.
- Item mappers round-trip representative Work Request state, activity, outbox, idempotency, and projection records.
- Transaction builder produces the expected put/update/delete operations for create and update commands.

## Phase 9: DynamoDB Repository and Unit of Work

Goal: implement the real DynamoDB repository and transactional command commit.

Scope:

- Implement `DynamoDbRepository`.
- Implement `DynamoDbCommandUnitOfWork`.
- Implement get state, list projection, list activity, and idempotency lookup operations.
- Implement transactional create and update commits.
- Map DynamoDB conditional failures to structured runtime errors.
- Add tests with mocked AWS SDK clients.

Out of scope:

- DynamoDB Local integration.
- CDK table creation.
- Outbox dispatch.
- Lambda HTTP adapter.

Acceptance criteria:

- Repository methods issue expected AWS SDK commands.
- Unit of work uses one transaction for state, activity, idempotency, projection, and outbox records.
- Conditional write conflicts map to `resource.conflict` or `idempotency.conflict`.
- Tests cover create, update, duplicate idempotency, and version conflict paths.

## Phase 10: EventBridge Publisher and Outbox Dispatcher

Goal: publish committed outbox events to EventBridge through AWS runtime adapters.

Scope:

- Implement `EventBridgePublisher`.
- Implement DynamoDB Streams outbox dispatcher.
- Filter stream records to pending outbox events.
- Publish EventBridge events with full envelope details.
- Mark outbox records published.
- Implement retry-safe behavior for already-published records.
- Implement outbox sweeper function logic.
- Add mocked AWS SDK tests for dispatch and sweeper flows.

Out of scope:

- CDK stream wiring.
- Live AWS smoke test.
- Worker queues.

Acceptance criteria:

- Dispatcher ignores non-outbox stream records.
- Dispatcher publishes pending outbox events with correct source, detail type, bus, and detail.
- Dispatcher marks events published after successful publish.
- Failures are surfaced so Lambda/DynamoDB Streams can retry.
- Sweeper processes only stale pending records and respects batch limits.

## Phase 11: Lambda API Adapter

Goal: expose the shared runtime through AWS Lambda-compatible handlers.

Scope:

- Implement API Gateway/Lambda request adapter.
- Parse route parameters into command and query requests.
- Resolve auth through configured provider.
- Return API success and error envelopes.
- Add Lambda handler factory for generated apps.
- Add unit tests for route handling and error mapping.

Out of scope:

- CDK API Gateway construct.
- Frontend hosting.
- Real deployment.

Acceptance criteria:

- Lambda adapter supports the same routes as the local HTTP adapter.
- Handler tests cover list, detail, activity, command success, validation failure, auth failure, and missing resource.
- The generated handler factory can be used without app-specific framework code.

## Phase 12: CDK Table, API, and Outbox Construct

Goal: synthesize the minimum AWS backend infrastructure for command execution and outbox publication.

Scope:

- Implement `JawStackResourceWorkflowApp` with internal constructs for:
  - DynamoDB table
  - HTTP API Gateway
  - API Lambda
  - EventBridge bus
  - Outbox dispatcher Lambda
  - Outbox sweeper Lambda and schedule
  - CloudWatch log groups
- Add explicit timeout, memory, reserved concurrency, and log retention.
- Add table stream and TTL.
- Add least-practical IAM permissions.
- Add CDK assertions tests.

Out of scope:

- SQS workers.
- Scheduler example.
- Frontend hosting.
- Deploy command.

Acceptance criteria:

- CDK tests prove the construct synthesizes.
- Table has stream and TTL configured.
- Lambdas have explicit timeout, memory, reserved concurrency, and log retention.
- API Lambda has table access.
- Outbox Lambda can update outbox records and put events to the bus.

## Phase 13: SQS Worker Runtime and CDK Wiring

Goal: add event-driven worker support.

Scope:

- Implement SQS worker adapter in `@jawstack/aws-runtime`.
- Implement worker idempotency record reads/writes.
- Add worker definition metadata support if not already complete.
- Extend CDK construct to create:
  - EventBridge rule
  - SQS queue
  - SQS DLQ
  - Worker Lambda
  - SQS event source mapping with max concurrency
- Add worker CDK assertions.
- Add mocked runtime tests.

Out of scope:

- Real notification provider.
- ECS workers.
- Multi-worker orchestration beyond the generated example.

Acceptance criteria:

- Worker adapter skips already-processed event IDs.
- Successful handler execution writes processed marker.
- CDK queue has DLQ, max receive count, visibility timeout, and max concurrency.
- EventBridge rule routes configured event types to the queue.

## Phase 14: Scheduler Runtime and CDK Wiring

Goal: add the scheduled stale-item reminder example.

Scope:

- Implement scheduler target adapter.
- Add Work Request stale reminder handler stub.
- Extend CDK construct to create EventBridge Scheduler schedule, target Lambda, retry policy, and DLQ.
- Add doctor checks for Scheduler retry and DLQ config.
- Add tests for scheduler handler behavior and CDK synthesis.

Out of scope:

- Real notification delivery.
- User-configurable workflow SLA engine.
- One-time schedules.

Acceptance criteria:

- Generated schedule is `rate(1 day)`.
- Schedule target has explicit retry policy and DLQ.
- Handler can find stale open work requests through repository interfaces.
- Tests cover no-op and stale-item paths.

## Phase 15: Angular Workspace and Resource Components

Goal: create the `@jawstack/angular` package with the core resource workflow components.

Scope:

- Add Angular library setup for `@jawstack/angular`.
- Implement provider and API client interfaces.
- Implement components:
  - `js-app-shell`
  - `js-resource-list`
  - `js-resource-detail`
  - `js-resource-form`
  - `js-command-button`
  - `js-command-dialog`
  - `js-status-badge`
  - `js-activity-timeline`
  - `js-empty-state`
  - `js-error-panel`
- Use standalone components.
- Use CSS variables and minimal dependencies.
- Add component tests for rendering, API calls, command form submission, loading states, error states, and role-disabled commands.

Out of scope:

- Generated app template.
- Visual polish beyond usable defaults.
- Large component catalog.
- Third-party UI framework integration.

Acceptance criteria:

- Angular package builds.
- Components render from Work Request metadata.
- Command form emits parsed input.
- List/detail/timeline components use the API client abstraction.
- Components handle loading and error states.

## Phase 16: Demo Work Requests App

Goal: assemble a local demo app in the monorepo using the packages directly.

Scope:

- Create `apps/demo-work-requests`.
- Wire Angular app routes:
  - `/work-requests`
  - `/work-requests/new`
  - `/work-requests/:id`
- Wire local API server.
- Use Work Request resource metadata and decision functions from an example module.
- Add app scripts:
  - `dev:web`
  - `dev:api`
  - `test`
  - `build`
- Add app-level tests for local happy path.

Out of scope:

- `create-jawstack` generator.
- AWS deployment.
- Frontend hosting.

Acceptance criteria:

- Demo web app runs locally.
- Demo API runs locally.
- A user can run the Work Request flow locally.
- App tests pass in CI without AWS credentials.

## Phase 17: Template App and Generator

Goal: turn the demo into a generated starter app.

Scope:

- Create `templates/angular-resource-workflow`.
- Implement `create-jawstack` CLI.
- Copy template files to a target directory.
- Apply app/package naming.
- Include Work Request example by default.
- Print next steps.
- Add generator tests using temporary directories.

Out of scope:

- Dependency installation automation unless explicitly requested by flags.
- Template upgrade support.
- Publishing to npm.

Acceptance criteria:

- `npx create-jawstack my-app` equivalent works in tests through the local package.
- Generated app has expected files and package scripts.
- Generated app typechecks and tests in fixture validation.
- Generator refuses to overwrite non-empty directories unless explicitly forced.

## Phase 18: Deploy and Destroy Commands

Goal: wire JawStack CLI deployment commands to the generated CDK app.

Scope:

- Implement `jawstack deploy <stage>`.
- Implement `jawstack destroy <stage>`.
- Run or require doctor checks before deploy.
- Delegate to CDK programmatically or through a controlled child process.
- Pass stage, region, and profile config.
- Print useful stack outputs.
- Add command tests with CDK execution mocked.

Out of scope:

- Live AWS deploy in unit tests.
- Smoke test command.
- Frontend hosting if not already included.

Acceptance criteria:

- Deploy command blocks unsafe dev auth unless overridden.
- Deploy command invokes CDK with expected stage/env.
- Destroy command invokes CDK destroy with expected stage/env.
- Errors are reported with actionable CLI output.

## Phase 19: Smoke Command

Goal: add a deployed-system verification path.

Scope:

- Implement `jawstack smoke <stage>`.
- Resolve deployed API URL from stack outputs or config.
- Create a work request through the deployed API.
- Read it back.
- Read activity.
- Poll for outbox/worker observable marker where available.
- Print grouped smoke results.
- Add tests with mocked HTTP responses.

Out of scope:

- General-purpose smoke scripting framework.
- Load testing.
- Multi-resource smoke scenarios.

Acceptance criteria:

- Smoke command exits `0` on the deployed happy path.
- Smoke command exits non-zero with clear failure details.
- Polling has explicit timeout and interval.
- Tests cover success, API failure, and timeout.

## Phase 20: Generated App Verification

Goal: prove the generated app works as an independent project.

Scope:

- Add fixture or script that generates an app into a temporary directory.
- Run install, typecheck, test, and build for the generated app.
- Run `jawstack doctor` against the generated app.
- Validate package references and scripts.
- Add CI job or CI step for generated app verification.

Out of scope:

- Live AWS deploy in default CI.
- npm publication.
- Browser E2E unless needed for confidence.

Acceptance criteria:

- Generated app verification passes from a clean temp directory.
- Generated app does not require AWS credentials for install, typecheck, test, build, or doctor.
- CI catches template drift.

## Phase 21: AWS Dev Deploy Smoke

Goal: perform and document the first real AWS dev deployment path.

Scope:

- Add manual or opt-in CI script for:
  - deploy dev
  - smoke dev
  - destroy dev
- Document required AWS credentials, region, and profile setup.
- Fix deployment issues discovered by the first real deploy.
- Verify generated resources can be destroyed cleanly.

Out of scope:

- Always-on CI deployment.
- Multi-account deployment strategy.
- Production deployment guide.

Acceptance criteria:

- A dev stack deploys to AWS.
- `jawstack smoke dev` passes against the deployed stack.
- `jawstack destroy dev` removes generated resources.
- Any retained resources are intentional and documented.
- Cost-sensitive resources are bounded by explicit defaults.

## Phase 22: Documentation and Public README

Goal: replace initial working docs with OSS-facing documentation for the MVP.

Scope:

- Write top-level README:
  - tagline
  - quickstart
  - generated architecture
  - core concepts
  - Work Requests example
  - cost guardrails
  - roadmap
- Add docs pages for:
  - quickstart
  - deploy to AWS
  - destroy your stack
  - resource
  - command
  - event
  - worker
  - schedule
  - cost profile
  - architecture overview
- Add architecture diagram.
- Mark vision docs as internal, archive them, or remove them when no longer needed.

Out of scope:

- Full marketing site.
- Broad tutorial series.
- API reference automation unless already available.

Acceptance criteria:

- A new developer can follow the README through local run and dev deploy.
- Cost guardrail docs avoid hard-cap claims.
- Roadmap matches PRD future directions.
- Working docs do not conflict with public docs.

## Phase 23: Release Preparation

Goal: prepare the workspace for a `0.0.x` dogfooding release and eventual `0.1.0`.

Scope:

- Add Changesets.
- Verify package names, exports, files, and dependency ranges.
- Add package README stubs.
- Add release workflow.
- Add npm provenance or publish settings if appropriate.
- Dry-run package packing.
- Verify `create-jawstack` template references compatible package versions.

Out of scope:

- Actually publishing unless explicitly approved.
- Stabilizing post-MVP APIs.

Acceptance criteria:

- `pnpm changeset` workflow is documented.
- `pnpm pack` or equivalent dry run succeeds for publishable packages.
- Package tarballs contain expected files.
- Release workflow is present but does not publish accidentally.

## Phase 24: MVP Release Candidate

Goal: cut the first coherent `0.1.0` release candidate state.

Scope:

- Run full local verification.
- Run generated app verification.
- Run opt-in AWS deploy, smoke, and destroy.
- Fix release-blocking docs and packaging issues.
- Tag an internal release candidate or prepare release PR.

Out of scope:

- New features.
- New product profiles.
- New AWS adapters.

Acceptance criteria:

- All MVP acceptance criteria in the PRD are satisfied.
- No known release-blocking doctor, deploy, smoke, or destroy issues remain.
- Public docs and package metadata describe the product accurately.
- The repository is ready for a release commit or PR.

## Cross-Phase Rules

- Do not start CDK or Angular work before the core runtime has Work Request tests.
- Do not add AWS deployment commands before CDK synthesis tests exist.
- Do not publish packages before generated app verification passes.
- Keep generated app files ordinary and editable.
- Keep `jawstack doctor` findings stable once documented.
- Update the technical design when implementation reveals a better contract.
- Update the PRD only when product scope changes.
