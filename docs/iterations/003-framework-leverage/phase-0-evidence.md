# Phase 0 Evidence: Frozen Baseline and Exercise Packets

Status: Phase 0 complete. Baseline inputs/packets are frozen and fresh baseline/candidate
release gates passed. Baseline A/B have not run and Phase 1 is not authorized.

## Source and Deliverables

Observed November 1, 2026. Original source HEAD is
`ae3268551bdda01592c6bdc08a76954e6eb1e02e`; it remains unchanged. The worktree already
contained the uncommitted Iteration 3 planning documents. This phase adds only measurement/
exercise tooling, test support, root verification wiring and documentation. No public
package or application runtime/provisioning source, lockfile or pinned tool version changed.
No stage/commit/push/merge/tag/publication/version operation was performed.

- [Frozen baseline](leverage/baseline.json): source/patch/input hashes, AST selectors/spans,
  domain exclusions, 1,589 selected protocol token-lines and 1,552 separately reported lab
  token-lines. The 50% gate therefore requires at most 794 selected post token-lines.
- [Inventory](leverage/inventory.json): selection/classification rules and proposed session
  settings, with a deliberately unset exact model identifier pending user coordination.
- [Task A](leverage/task-a.md) / [Task B](leverage/task-b.md): neutral specifications,
  acceptance suites, typed thin-adapter contract and explicit runner; no benchmark features.
- [Compatibility reference](leverage/compatibility.json): create-only captured rows/keys,
  wire bytes/fingerprints, failure/replay summaries and marker formats from existing code.
- [Packet runbook](leverage/README.md): fresh worktree/session setup, bounded visible timing,
  ignored raw evidence, honest failure/partial results and post-accounting procedure.

`baseline.json` was captured at `2026-11-01T20:27:56.668Z`, with Node 24.16.0,
pnpm 10.21.0 and TypeScript 5.9.3. Its formatted-file SHA-256 is
`3a2f24dcff65b877291944730b68016879285d45f955b0b427fa22a196f8537c`.
Its tracked-patch hash identifies changes present at capture; per-input/runtime hashes
also cover untracked packet/support files. Subsequent status/evidence-only edits are not
changes to the frozen runtime or task specification.

## Fresh Baseline Verification

A new local clone at `/tmp/jawstack-iteration3-phase0-baseline` contained the committed
source only, without `node_modules`, `dist`, env files, manifests or review data. Ran
`pnpm install --frozen-lockfile` then `pnpm verify:release`, with tests before package
builds. No preparatory build or workspace copy masked source-resolution problems.

The release gate passed: **806 workspace tests**, including **512 Content Operations
tests**, plus format/typecheck/lint/build, zero pkg-guard findings, generated-app
install/lint/typecheck/tests/browser and AWS builds/synth/doctor, and six package dry runs.
The release log was created at `2026-11-01T20:10:47.380Z` and last written at
`2026-11-01T20:13:02.559Z`; these are log-file timestamps, not an agent-effort measurement.

`pnpm --filter content-operations test:browser` then passed **30/30** cases, zero
skipped/unexpected/flaky and no retries. Playwright reports start
`2026-11-01T20:14:42.117Z`, duration **499,099 ms** rounded to milliseconds, one worker,
desktop 1440x900 and mobile 390x844. Screenshot/layout assertions and actual bitmap,
publication and recovery checks ran. The desktop scheduled-publication and mobile recovered-
attempt screenshots were also visually inspected. Test servers on 4436/4437 stopped.

Logs stay locally at `/tmp/jawstack-phase0-install.log`,
`/tmp/jawstack-phase0-release.log` and `/tmp/jawstack-phase0-browser.log`; browser results
and screenshots stay in that clone's ignored `apps/content-operations/test-results/`.
The pristine release log SHA-256 is
`61d9b51f308c854bbe8fe9f4ff943ea548d53b7c842cbcde1c2c6dc173dbd010`;
the browser log SHA-256 is
`c1903363af3dff5951886bead2a2ee7e60b99c7608896483241a37a42066f1d6`.

## Phase 0 Tooling Verification

| Gate                                                           | Result                                                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test:tooling`                                            | Passed: eleven Node tests plus one actual compatibility-golden test.                                                                                                     |
| `pnpm typecheck:tooling` / `pnpm lint:tooling`                 | Passed: benchmark contracts/config/acceptance suites typecheck and lint without a feature adapter.                                                                       |
| `pnpm leverage:measure verify`                                 | Passed: frozen input/source/span/count/framework-export checks.                                                                                                          |
| `pnpm leverage:exercise --task a --check` / `--task b --check` | Passed readiness only; both report `exerciseExecuted: false`.                                                                                                            |
| Runner negative paths                                          | Passed: missing adapter, invalid/duplicate flags, unsafe paths and changed frozen fixture refuse; no candidate test/model/service is started.                            |
| Counter/timing negatives                                       | Passed: overlap/trivia/contextual tokens, domain exclusions, collisions/bounds, escaping symlinks, malformed selectors, wait union and invalid token/count/rule inputs.  |
| Clean candidate install/release                                | Passed in a second source-only clone: 806 workspace tests plus eleven Node tooling tests and one compatibility test; full release checks and frozen-source verification. |
| Baseline A/B and post A/B                                      | **Not run.** No feature acceptance result or agent comparison is claimed.                                                                                                |

The second clone `/tmp/jawstack-iteration3-phase0-candidate` overlays all Git-visible
Phase 0 files onto the same committed HEAD, without ignored modules/builds/env/lab data.
Its gate starts with a fresh frozen install and tests before builds. Logs are
`/tmp/jawstack-phase0-candidate-install.log` and
`/tmp/jawstack-phase0-candidate-release.log`.

The candidate gate passed with tests before builds, generated-app checks, zero pkg-guard
findings and six package dry runs. Its release log was created at
`2026-11-01T20:28:12.652Z`, last written at `2026-11-01T20:31:17.838Z`, SHA-256
`462f812cc56b9ee31d11a052b06bf1f2d8ce1a61e7cf17c751546ebd136534f1`.
The subsequent `pnpm leverage:measure verify` passed in that clone as well. Final edits
after this gate only update status/evidence/index Markdown outside frozen task inputs;
formatting and local links are checked on the actual review diff.

Final working-tree checks passed: `pnpm format:check`, frozen-baseline verification,
`git diff --check`, and a Markdown audit of **51 files / 210 local links / 34 anchors**
with zero broken targets. The staged diff is empty. A final runtime-scope diff against
HEAD confirms no package, Content runtime/script/Compose or lockfile change.

The first development-time compatibility capture failed because the synthetic review
payload did not satisfy existing strict domain schemas. The fixture was corrected to
the actual review/attempt schemas before any golden was written; create-only capture and
subsequent equality tests passed. No runtime schema or assertion was weakened. Fresh
installs retain the known prebuild workspace CLI-bin warning because its `dist/cli.js`
does not exist until build; it is not a Node engine warning or a new Phase 0 regression.

## Live Baseline Provenance and Exclusions

**No fresh LocalStack run occurred in Phase 0.** Preserve the complete prior
[Iteration 2 acceptance evidence](../002-content-operations/localstack-evidence.md#phase-24-final-acceptance-audit)
and [outcome](../002-content-operations/outcome.md#final-verification), explicitly as
historical observations: live browser acceptance passed at `2026-11-01T15:52:22.794Z`
in 233,431 ms; the full real-service failure/reset/reprovision/teardown gate passed from
`2026-11-01T15:56:17.228Z` through `2026-11-01T16:13:31.838Z`, in 1,034,610 ms.

Compared the historical verification source `45500a40db3df53cef6a555319243cb3089e350d`
with current source bytes: **131 paths, zero differences**, covering all Content `src`,
all public package `src`, Content scripts/Compose and lockfile. Later committed changes
affect docs/test fixtures/source-resolution/lint verification, not those runtime inputs.
The historical log records its narrow browser-fixture overlay separately; the current
30-case browser run provides fresh evidence for the merged fixture/configuration.

This comparison justifies retaining that live before-state reference, not treating it
as a fresh image/account/network/ZIP attestation. Existing records identify the pinned
LocalStack 2026.10.0 image/digest and user-attested Hobby plan. The shared-lab and migration
phases must rerun their actual live gates with current archive/profile/ownership evidence.
No token/env file was read or copied, Docker/lab command run, paid trial used, real AWS
request/deployment made, remote workflow dispatched or secret/environment changed.

The user's existing 4337 API remained healthy (`memory` / `managed`), and a read-only
check confirmed content `10000000-0000-4000-8000-000000000002` still version 3 / draft.
Its processes were not restarted and no review data was written/reset.

## Next Gate

Review the inventory/classifications, packet assertions and Phase 0 diff; the user commits.
Then follow the [session handoff](leverage/README.md#baseline-session-setup) in two independent
fresh baseline sessions with agreed visible model/tool/settings/budgets. Capture actual
baseline A/B outcomes before authorizing Phase 1. Packet readiness and this agent's
experienced context are not substitutes for those observations. No productivity claim,
framework extraction or release follows automatically from Phase 0 completion.
