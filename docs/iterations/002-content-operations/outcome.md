# Iteration 2 Outcome: Content Operations

Status: complete. AC-01 through AC-11 are met within the reviewed local-only scope.
This report records local acceptance and merge readiness, not authorization to merge,
tag, publish, or deploy. The user reviews and commits the uncommitted diff.

## Delivered

The maintained private [reference consumer](../../../apps/content-operations/README.md)
supports a complete small-team editorial workflow beyond Work Requests. Content owns
draft/revision/review/approval authority, verified attachment membership, schedule generations,
and immutable publication intent. Linked review/asset resources materialize facts rather
than making independent editorial decisions. Five Angular views expose real queries,
version-safe editing, snapshots, private media, calendar/agenda, attempts, local notification
deliveries, failure history, and eligible editor recovery.

Memory is credential-free and volatile. The separately provisioned Hobby lab runs actual
DynamoDB/stream -> outbox dispatcher -> EventBridge -> SQS -> Lambda work, private S3,
automatic Scheduler jobs, durable DLQ collection, and bounded retry/replay. Both modes use
the same HTTP application and shared execution factories. There is no real-AWS fallback.

## Acceptance Mapping

All paths below are relative to `apps/content-operations` unless linked otherwise. `R`
denotes the root `pnpm verify:release`; `B` the complete memory `test:browser`; `LB` the
separately provisioned `test:browser:local`; and `L` the destructive
`verify:local --confirm-reset`. Commands, results, and limitations are detailed below and in
the [local evidence log](localstack-evidence.md). Test names are evidence locators, not
claims that a unit/mock test independently proves the deployed transport.

| PRD   | Delivered behavior and primary evidence                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC-01 | Documented install/build, explicit memory startup, non-overwriting six-stage seed, distinct author/editor fixtures. `R`: `test/unit/http.test.ts` seed/workflow/identity checks. `B`: `content.spec.ts`, `reviews.spec.ts`, `workflow.spec.ts`. [Runbook walkthrough](../../../apps/content-operations/README.md#fixtures-and-walkthrough).                                                                                                |
| AC-02 | `contentItem`, linked `reviewTask`, and `asset` use public core commands and memory/DynamoDB query contracts; custom typed HTTP queries and scoped persistence are documented application extensions. `R`: `editorial`, `transactions`, `paging`, `api-queries`, `workers` unit suites; public package query regressions. `B` / `LB` / `L`: materialized resources and related outcomes.                                                   |
| AC-03 | Ownership/roles, expected versions, frozen review/revision IDs, scoped idempotency and atomic conditions reject invalid/stale transitions or converge on a stored response. `R`: `editorial`, `transactions`, `http`, `publication`, `workers` tests. `B`: concurrent draft/review conflicts and reconciliation; `L`: ingress denials/conflicts and stale delivery guards.                                                                 |
| AC-04 | Actual uploaded image, editor approval, automatic due evaluation, one stored publication artifact and linked local notification. `B` / `LB`: shared `workflow.spec.ts` checks decoded bitmap, materialized rows, committed preview/download and operations. `L`: exact private bytes/digest/object count, actual automatic job and receipts. Memory clock-driven scheduling tests are additional contracts, not cloud evidence.            |
| AC-05 | Reopen/cancel/reschedule invalidate old approval/schedule generations; old facts cannot publish obsolete state. `R`: `editorial`, `publication`, `jobs`, `publisher`, `time` tests; `B`: `calendar.spec.ts` conflicts/cancel/reopen/DST; `L`: obsolete-generation and late-delivery matrix.                                                                                                                                                |
| AC-06 | Committed transaction reaches bundled workers through real local streams/bus/queues/Lambda; private S3 and automatic Scheduler outcomes are observable. `LB` and `L`, with no host pump/direct Lambda invocation; source/profile/queue contracts and `aws-runtime` tests in `R`. CDK template parity is a separate synth assertion.                                                                                                        |
| AC-07 | Deployed transient retry, post-object interruption, live/expired leases, three terminal receives/redrive, collector interruption/reconciliation, editor generation-two retry, targeted CLI replay, marker-loss duplicates, and one logical artifact/delivery. `L` is authoritative live evidence; `R`: `publisher`, `failures`, `recovery-transport`, `notifications`, `local-verification`; `B`: `operations.spec.ts` memory recovery UI. |
| AC-08 | Explicit dummy credentials/endpoints and final transport guard; inherited AWS config and unsafe/missing endpoints reject before network. `R`: `isolation`, `spine`, `cleanup`, `local-verification`, `synthesis-api`; `L`: 24 negative isolation probes, missing-service failures, unrelated sentinel survival, reset/reprovision and owned running/exited/removing-runtime handling. Foreign lookalikes are refused before shutdown.      |
| AC-09 | All five workbench surfaces, meaningful dependency/validation/conflict states, bounded URL paging, keyboard/focus/identity behavior, desktop/mobile fit. `B`: all seven spec files via `fixtures.ts` error/layout/screenshot assertions; `LB`: actual asynchronous workflow in both viewports. Component/client/route contracts and bundle boundary are in `R`. Chromium is the tested browser, not a cross-browser certification.         |
| AC-10 | Work Requests preserved; public query, Angular, CDK and runtime regressions pass. `R`: workspace tests, lint/typecheck/build, source and compiled browser boundaries, isolated generated install/test/build/synth/doctor, pkg-guard and six package dry runs. The generator still emits Work Requests, not this consumer.                                                                                                                  |
| AC-11 | Current application runbook/modes/protocols/API/workbench/infrastructure, product composition docs, unchanged historical foundation plans, this outcome, and sanitized phase/live evidence distinguish implementation from exclusions. Final formatting, local link/anchor audit and diff checks complete the documentation gate.                                                                                                          |

The criteria are the [reviewed PRD's AC-01 through AC-11](prd.md#verification-and-acceptance).
Its [technical design](technical-design.md) and [phase evidence](implementation-plan.md#phase-evidence-log)
remain historical intent and implementation chronology, not deployment instructions.

## Final Verification

Phase 24 uses a fresh local clone of source commit
`45500a40db3df53cef6a555319243cb3089e350d` without `node_modules`, compiled outputs,
local manifests, tokens, or browser caches in the checkout. `pnpm install --frozen-lockfile`
and `pnpm build` ran before the release gate. The ignored token is used only by the
original workspace's owned live-lab launcher; no secret was copied into that clone.
The same narrow browser-fixture patch was applied to the clean checkout before final
regressions. No application/framework runtime code changed; final formatting/links are
checked on the review diff. Final product/package Markdown is also copied into that
verification checkout so package dry runs include the updated READMEs, not older artifacts.

The first live browser attempt failed its desktop case when the fixture generated
`2026-11-01T15:41:00`: the native `datetime-local` control canonicalized that to minute
precision, and Playwright rejected its non-identical value as malformed. The mobile case
passed, but that run remains failed. The fixture now always enters a canonical whole
minute at least thirty seconds ahead and asserts the actual input value. It does not
increase timeouts, retry failed tests, accelerate clocks, or change scheduling behavior.
The failed report is retained separately; release, memory and live acceptance are rerun
after the correction, not inferred from the earlier pass.

| Gate                             | Final result                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clean install/build              | Passed with Node 24.16.0 / pnpm 10.21.0. A first-install workspace CLI-bin warning occurs before its `dist` exists; the build and subsequent CLI verification succeed.                                                                                       |
| `pnpm verify:release`            | Final current-docs/package-README overlay passed in the clean-install checkout: 804 workspace tests, including 511 consumer tests; typecheck/lint/build/format, zero pkg-guard findings, isolated generated-app checks and six package dry runs.             |
| Consumer browser boundary        | Passed in the clean build: 230 modules, zero server imports.                                                                                                                                                                                                 |
| Complete memory browser suite    | Corrected-fixture rerun passed: 30 cases, zero skipped/unexpected/flaky, one worker, no retries; desktop 1440x900 / mobile 390x844. Started `2026-11-01T15:45:18.210Z`, duration 365,528 ms.                                                                 |
| Hobby browser workflow           | Corrected-fixture rerun passed: both viewports, zero skipped/unexpected/flaky or retries; actual external workers. Started `2026-11-01T15:52:22.794Z`, duration 233,431 ms.                                                                                  |
| Full Hobby verification/teardown | Passed / `go`: `2026-11-01T15:56:17.228Z` through `2026-11-01T16:13:31.838Z`, 1,034,610 ms. Full deployed matrix, restored archives, sentinel/reset/reprovision and final teardown passed; zero owned containers/network, manifest removed, images retained. |
| Documentation / working tree     | Passed: 43 Markdown files, 182 local links, 31 anchors, formatting and `git diff --check`; all owned test ports closed, review app preserved, source HEAD unchanged, no staged changes or release/version operation.                                         |

Ignored browser artifacts stay under `apps/content-operations/test-results/` in the clean
verification checkout for memory, and in the working checkout for LocalStack. Sanitized
integration results stay under `.localstack/<lab-id>-evidence.json`. They are local evidence,
not committed secrets/manifests or a claim of an uploaded GitHub artifact. Successful
screenshots are visually inspected as well as machine-checked for layout/media.

The actual documented memory API/seed CLI was additionally exercised in the clean checkout
on isolated 4637/4636 after live teardown: `memory` / `managed` health, six initial creates,
six repeat skips, and all six lifecycle examples read back successfully. The temporary API
was stopped afterward. Selected diagnostics passed the size/symlink checks: memory 75 files /
8,102,302 bytes; live eight files / 610,063 bytes. Existing review API 4337 remained healthy
with its edited fixture still version 3 / draft; its web/API processes were not restarted.

## Framework Changes

- `@jawstack/core`: additive `Page`, projection/activity query contracts, memory keyset
  paging and shared bounded cursor preparation helpers. Existing command and array reads remain.
- `@jawstack/aws-runtime`: DynamoDB paged-query parity over one bounded query and validated
  service continuation/error behavior. Existing public builders/mappers also support the
  consumer-owned transaction composition; their reuse is not a new arbitrary-write API.
- `@jawstack/angular`: browser-safe `ResourceUiDefinition` / `CommandUiDefinition` and
  structured `JawStackApiError`, with source/compiled browser-boundary regressions.
- `@jawstack/aws-cdk`: readonly exact-name worker/scheduler binding maps and narrow optional
  batch/DLQ-visibility/event-source settings, preserving old defaults/logical IDs.
- Shared tooling: separated secret-free release/memory-browser gates and manual protected
  Hobby workflow, sanitized bounded artifacts, and no push-triggered Actions builds.

See [Application Composition](../../application-composition.md) and owning package READMEs.
Editorial commands, logical expiry, typed operation rows, immutable object protocol,
publication claims, jobs, fixture auth, local notifications, failure/replay, and lab lifecycle
remain consumer-owned. This iteration does not extract a speculative capability ecosystem.

## Gaps and Unperformed Checks

- No real-AWS deployment, cost measurement, production auth/tenant isolation, API Gateway
  execution, CloudFormation asset delivery, or live IAM enforcement. Consumer CDK entrypoints
  intentionally reject real-AWS contexts and synth only the bounded JSON ingress.
- LocalStack automatic success/retry/redrive observations are not general AWS parity,
  especially Scheduler failed-delivery retry behavior. Hobby entitlement is user-attested;
  the launcher does not programmatically audit billing or licensing.
- Notification delivery ends at a durable local sink. No email/Slack/provider effect,
  production retention/backup/restore, antivirus/full media decoding, rich-text CMS,
  multitenancy, or exactly-once external-effect guarantee is supplied.
- The consumer is bounded and single-workspace. Memory is volatile; verified historical
  bytes/tombstones are retained; finite attachment/store/retry capacities can reject more work.
  Queries are paged, non-snapshot reads, not full-workspace counts or an unbounded search API.
- Browser acceptance is Chromium desktop/mobile emulation. Clock/fault-driven memory UI
  scenarios are not deployed-failure evidence; live diagnostics that republish exact stored
  facts are identified separately from original automatic application traffic.
- Remote GitHub Actions dispatch and owner environment setup are **not run** here. The
  manual cloud gate needs merged default-branch workflows and a restricted `localstack-hobby`
  environment with environment-scoped token and Hobby attestation. Missing prerequisites
  produce a failing `NOT-RUN`, not an integration pass. See [CI setup](../../../apps/content-operations/WORKBENCH.md#ci-and-diagnostics).

## Release Assessment

The reusable query, Angular, and CDK additions justify considering a coordinated **0.0.2
dogfood release** after review. They are more than consumer-only changes, and isolated
packaging/generated-app verification now provides a credible release baseline. Publication
would let external consumers install them without workspace aliases; that is a separate
decision, not a prerequisite for merging this private reference app.

Do not call this `0.1.0` or imply production readiness: authentication/deployment/provider
contracts and a second independently installed consumer still need deliberate product work.
Keep versions at `0.0.1` now. A future release should follow the
[release checklist](../../release-checklist.md), record additive contracts and remaining
limits, choose distribution/tag policy explicitly, and obtain authorization for any publish
automation, credentials, version bump, tag, or real-AWS cost-bearing verification.

This phase prepares a reviewable merge candidate only. It does not commit, push, merge,
tag, publish, change package versions, or deploy to AWS.
