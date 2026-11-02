# Phase 7 Evidence: Opt-In Collector Infrastructure

Status: complete, uncommitted for user review. Review base:
`2016889f90d631b2ca0c47d90872593e58b2cf82`. No staging, commit, push, tag, version bump,
publication, remote workflow dispatch or real AWS deployment occurred.

## Delivered

- Optional `recoverableWorkers: { definition, collectorHandler }` on the existing
  `JawStackResourceWorkflowApp`, plus public type `JawStackRecoverableWorkers` and frozen,
  null-prototype `collectorFunctionsByName`. No opt-in returns an empty named map.
- Pre-service validation checks core-owned definition identity, resource/command metadata,
  worker names/subscriptions/concurrency, exact worker-handler keys, bounds, collector asset
  existence/type and normalized physical-name collisions/length. No second subscription
  list, positional grant binding or application runtime implementation was introduced.
- One collector consumes each existing named worker DLQ. Workers/collectors use 30 seconds,
  256 MiB, concurrency two and batch one. Source/DLQ visibility is 180 seconds; source
  retention four days, DLQ retention fourteen days, source redrive three receives, logs
  seven days. There is no extra store, queue or collector-DLQ chain. Existing outbox
  sweeper concurrency one is unchanged.
- Collectors receive exact-table GetItem/Query/PutItem/DeleteItem and matching-DLQ consume
  grants. Dedicated roles write only their explicit log groups, without the default broad
  managed logging policy. No inferred S3, EventBridge, jobs or infrastructure-discovery
  grants. Applications retain explicit domain permissions through stable named bindings.
- All opt-in Lambda roles receive exact-table DescribeTable/ListTagsOfResource, plus workflow
  name/hash/source environment values; the table gets its workflow hash tag. Workers and
  collectors additionally receive their exact consumer/source/DLQ identity and role. Other
  local ownership/routing tags and bindings remain the later provisioner's responsibility.
- Shipped [composition recipe](../../../packages/aws-cdk/recovery.md) covers the actual
  public API, handler contract, named grants, local-only bounds and migration caveats.
  No new dependency, lockfile edit, package, root value export or suppression was added.

## Verification

A fresh clone at `/tmp/jawstack-iteration3-phase7-verification` received Git-visible files
only, excluding ignored dependencies, builds, tokens, manifests and review data. Ran
`pnpm install --frozen-lockfile` then `pnpm verify:release` on Node 24.16.0 / pnpm 10.21.0,
tests before builds with no preparatory build.

| Gate                        | Actual result                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Workspace tests             | 1,257 passed: core 345, AWS runtime 250, CDK 73, Angular 44, CLI 20, generator 7, Work Requests 2, Content 516.               |
| Tooling/compatibility       | Eleven Node tests and one frozen compatibility test passed: 1,269 primary tests, excluding the generated fixture's two tests. |
| New coverage                | 37 CDK tests and one Content synthesis comparison.                                                                            |
| Typecheck/lint/format/build | Passed in the fresh clone.                                                                                                    |
| Browser boundaries          | Passed; Angular remains 329 modules and zero server imports.                                                                  |
| Package guard               | Zero errors, warnings or info; no new suppression.                                                                            |
| Generated app               | Install/lint/typecheck/two tests, browser/AWS builds, synth and doctor passed; no doctor findings.                            |
| Package dry runs            | All six passed. CDK: six files / 51,019 bytes unpacked, including `recovery.md`.                                              |

CDK tests cover named wiring with reordered consumers, strict configuration mismatches,
accessor rejection, the 40-consumer bound, retention/removal, scoped policies, explicit
domain grants, role/environment identity and no collector chaining. The full no-opt-in
template fixture was captured against the review base's **old implementation**, then
compared with the new construct; existing logical-ID regressions remain unchanged.
Fixture SHA-256: `de219dd7031e994a67ab63ca920391ec5eeb746e71f45eb10a220db28a2f0315`.

The Content fixture uses its actual resource/profile declarations and built assets. It
compares all four collector names/settings, existing source/DLQ properties, mappings,
logs/retention and queue grants after normalizing logical references. Collector data/log
permissions are intentionally narrower; metadata reads are additive. Readonly event-schema
wrappers are explicitly unwrapped in this test to meet core's strict-object contract, with
the original Content parser retained for identity/refinement validation. This is not a
consumer runtime migration or proof of interchangeable handler implementations.

Release log `/tmp/jawstack-phase7-release.log`: created `2026-11-02T01:49:58.541Z`, last
written `2026-11-02T01:53:12.934Z`, SHA-256
`0607210ff1759a4b313e926322383249fe6c1932545627ced2d07cdfdeb001e1`.
This log window is not agent-effort measurement. The install log retains the known missing
prebuild CLI-bin warning; existing browser externalization/build timing and CDK feature-flag
notices remain nonblocking. Zero findings above refers to package guard/doctor.

All ten selected files (CDK source/tests and the Content infrastructure test) match the
clean clone. SHA-256 of their sorted `[path, fileSha256]` list:
`34c850ec9c06b128e9beb8f3e3ba4202b589f35d57709b797ce263766fbe4ded`.
Subsequent repository edits are Markdown status/evidence only, covered by format/link/diff
checks. No UI changed and no new browser interaction suite was necessary.

## Installed Public API

Packed the clean clone into `/tmp/jawstack-phase7-packed` and installed into the independent
`/tmp/jawstack-phase7-installed-smoke` without workspace source aliases. Tarball SHA-256:

- Core: `44b8db639a802d11dce14b26a6b2fb5a3561dafc36d32c1eb99cfa153aff6bf9`.
- CDK: `3ed9314ac0f60b1c1eba2298f6954b8ef5a85959fc8defb60970fc2a3f5efb80`.

Mechanically extracted both installed recipe blocks into TypeScript modules. TypeScript
5.9.3 strict NodeNext/exact-optional checking passed with the repository's `skipLibCheck`
setting. A second strict check with `skipLibCheck: false` and exact-optional disabled also
passed. The initial combination of both strict declaration checking and exact-optional
failed in upstream CDK 2.260.0 declarations; no dependency patch or blanket compatibility
claim conceals that limitation. Only compiler/Node declarations come from the workspace.

Emitted ESM resolves installed `dist/index.js` for core/CDK. The synthetic consumer creates
five functions, two queues and three mappings (including the existing outbox stream), checks
exact collector/DLQ settings and scoped roles, exercises the documented named S3 grant in
a separate stack, and verifies a legacy four-function stack has no collectors/metadata
grant. Assets are explicitly test-only handlers; no business execution is claimed.

Install/type/declaration/recipe logs are `/tmp/jawstack-phase7-installed-*.log`. Successful
recipe log last written `2026-11-02T01:54:28.982Z`, SHA-256
`e0177d46ddffcf87f20bfa4c6b3e7b6055811d3e5b69804535e1bf21bc251617`.

## Boundaries and Integrity

This is credential-free synthesis, not AWS IAM enforcement, deployment, SQS redrive or
live recovery evidence. Three receives/concurrency two remain the reviewed **local** bounds,
not production recommendations. Collector asset existence does not validate executable
contents. Matching manifest metadata does not prove identical callback/schema bodies.

Content collector leaf IDs and physical names match where compatible, but moving ownership
under the framework changes CloudFormation logical IDs and introduces dedicated roles.
An already deployed stack needs deliberate import/logical-ID migration handling; no
automatic adoption is claimed. Content's runtime, stack and provisioner remain unchanged.

The frozen counter reports CDK **739 -> 1,028 (+289)** token-lines. Core remains 6,298;
AWS runtime 3,082. Selected consumer protocol remains **1,589**, separate lab code **1,552**.
There is no consumer-code retirement or measured agentic speed improvement yet.

Baseline/task packets, PRD/TDD and compatibility fixture remain unchanged; both task packet
`--check` commands pass. No A/B run/refreeze occurred. The prior lockfile deviation remains
`f02122587adff88187d9422a8f150e91b566cac80113e2b767bbf3c61a409179`, with no new edit here.
Read-only probes confirm the review API on 4337 stays memory/managed and healthy; the review
item stays version 3 / draft. No review server/data was restarted/reset, Docker/emulator
started, token file read or real AWS request made. Staged diff is empty.

Next: Phase 8 extracts shared lab ownership/lifecycle; live delivery, consumer migrations
and post-extraction leverage acceptance remain later gates.
