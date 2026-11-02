# Phase 8 Evidence: Shared Lab Ownership and Lifecycle

Status: complete, uncommitted for user review. Review base:
`32d554041d7e9ead3a2f245a2b26d2093b3fce8f`. No staging, commit, push,
tag, version bump, publication, remote workflow dispatch or real AWS deployment occurred.

## Delivered

- Private `@jawstack/local-lab` under `tooling/local-lab`, included in workspace/root
  build/typecheck/lint/test filters. Public packages have no dependency on it. Its supported
  commands/operations are implemented lifecycle checks, up, readiness/inspection and down;
  there is no shared provision/reset command yet.
- App-neutral finite profile inventory, bounded own-data parsing, captured/frozen profiles,
  canonical profile hashes and bounded prebuilt ZIP identity checks. New schema-2 manifests
  record profile/archive identity and timestamped user Hobby attestation, never the token.
  Profile/archive changes reject before service/Docker mutation; down does not need assets.
- Shared owner-tag/mapping preflight, finite mapping deletion/polling/missing-resource helpers,
  runtime reconciliation, Docker startup, readiness and exact-ID container/network teardown.
  All candidates and network members are preflighted before stopping the creator; children
  are reconciled again after it stops. Running/exited/already-removing behavior is preserved.
- New emulator/network checks require exact project/service/owner/profile/image identity,
  fixed localhost-only port publication and only proven attached members. Unsafe transitions,
  foreign lookalikes and unproven cleanup retain the manifest. No pruning or image deletion.
  On-disk owner/profile identity is revalidated before teardown and save, with per-manifest
  exclusive locks for cooperating launchers. Interrupted locks require investigation, not
  automatic stale-lock adoption.
- Startup alone reads an explicitly selected token file and passes the token only to the
  startup Docker subprocess. Other operations do not discover/read that file or require the
  token. The pinned image/digest, fixed local origins and user-attested Hobby boundary remain.
  New tooling consumes public `@jawstack/aws-runtime/local` transport rather than copying
  SDK credential/destination policy. Imports perform no client construction/token reads/I/O.
- Content delegates lifecycle and runtime cleanup through thin adapters and registers its
  current function/archive/resource inventory as data. The duplicate app-owned Compose
  file is removed; shared tooling generates a private temporary document containing a token
  placeholder. Existing service providers/reset and application proof scenarios remain
  app-owned until Phase 9. No writer, delivery owner, collector implementation or review UI
  was migrated.
- Legacy schema-1 decoding is available only to the lifecycle's explicit known teardown
  profile. No save, upgrade or lifecycle mutation other than owned down is permitted.
  Content's other manifest readers now require schema 2. Unknown/unprovable legacy state
  stays refused; no manifest is deleted to bypass ownership checks.
  In particular, an empty untagged legacy network is not adopted by its Compose labels;
  removing it requires an owned attached-container proof captured for that exact network.

See [private tooling documentation](../../../tooling/local-lab/README.md) and the updated
[Content runbook](../../../apps/content-operations/README.md).

## Verification

Final-source verification uses `/tmp/jawstack-iteration3-phase8-release-verification`, a
fresh clone overlaid with Git-visible source only. Ignored builds/dependencies, token files,
manifests and review data were excluded; the tracked Compose deletion was also applied. Ran
`pnpm install --frozen-lockfile` and `pnpm verify:release` on Node 24.16.0 / pnpm 10.21.0,
with tests before builds and no preparatory build.

The final source passed all gates, including the legacy-network regression.

| Gate                        | Actual final result                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Workspace tests             | 1,295 passed: core 345, AWS runtime 250, CDK 73, Angular 44, CLI 20, generator 7, private lab 37, Work Requests 2, Content 517. |
| Tooling/compatibility       | Eleven Node tests and one frozen compatibility test: 1,307 primary release tests, excluding the generated fixture's two tests.  |
| New regressions             | 37 private-tooling tests and one Content profile/asset registration test.                                                       |
| Typecheck/lint/format/build | Passed.                                                                                                                         |
| Browser boundaries          | Passed; Angular remains 329 modules and zero server imports.                                                                    |
| Package guard               | Zero errors, warnings or info; six public packages checked, three private packages skipped; no new suppression.                 |
| Generated app               | Install/lint/typecheck/two tests, browser/AWS builds, synth and doctor passed; no findings.                                     |
| Package dry runs            | All six passed; public package contents/sizes unchanged from Phase 7.                                                           |

Tests cover two independent profiles, missing/changed archives, malformed/oversized/foreign
manifests, profile capture/hashes, legacy down-only refusal, missing/foreign ownership,
network membership/ports, orphan restart refusal, token/Hobby boundaries, lock/save identity,
cleanup failure retention, final transport rejection and no-I/O imports with unsafe inherited
AWS settings. Root-filter and package/source dependency checks prevent public-to-private or
shared-to-app coupling. Existing Content runtime-removal and service-preflight suites pass.

Two initial parallel release runs timed out in different existing AWS tests, including one
with Docker idle. The 58 related tests passed in isolation. Root tests now run one package
at a time while retaining each package's file-level workers; this avoids multiplying full
Vitest pools. No assertions, test time limits or retries were loosened. Both preceding bounded
full gates passed. The final rerun covers removal of a redundant launcher manifest pre-read
and the extra legacy-network regression. Bounded shared decoding is used throughout.

Final log `/tmp/jawstack-phase8-release-final.log`, last written
`2026-11-02T02:45:52.001Z`, SHA-256
`5353d5b8444e417644b94144226b4fbc2e90f66ed838e7c8c8073746caac3d9d`.
`/tmp/jawstack-phase8-release-install.log` retains the known missing prebuild workspace
CLI-bin warning. Existing browser externalization/timing and CDK feature-flag notices
remain nonblocking. Zero findings above refers to package guard/doctor, not every tool notice.

All 27 selected non-Markdown source/config/test files match the final clone; the deleted
Compose file is absent there. SHA-256 of their sorted `[path, fileSha256]` list:
`11ccab4567c3ffeccc0409eb229eacc6f6fa996d8660b2a0f753c69906c8d954`.
Subsequent documentation/status edits receive format/link/diff checks. No UI changed and no
new browser interaction suite was run.

## Actual Local Lifecycle

The explicit lifecycle script used the existing ignored Content token file, selected by
absolute path, with its Hobby setting key. Its sanitized final proof ran
`2026-11-02T02:20:00.809Z` through `2026-11-02T02:21:22.875Z` under unique project
`jawstack-lifecycle-p8715490`, using the unchanged pinned image/digest.

- Started a schema-2 owned emulator and invoked a tiny real Node 22/ARM64 Lambda using
  public-local transport/dummy clients. Observed one real warm runtime and used its actual
  cached image for additional running/exited ownership fixtures.
- A separately owned same-name-pattern runtime made down refuse before stopping the
  emulator or the running owned fixture. The manifest and fixture owners remained intact.
  The proof removed only the exact foreign sentinel it had itself created.
- Removed the owned creator to exercise orphan handling. Restart refused; token-free down
  stopped one running orphan and removed two remaining owned fixtures. Final inspection
  reported zero emulator containers, Lambda runtimes or owned networks, with images retained
  and the manifest removed. An unrelated sentinel survived and was separately removed by
  exact proof-owned identity.
- Then ran Content's actual `local:up` and `local:down` launchers with fresh lab ID
  `phase8check`. Startup reached readiness; teardown reported zero containers/networks and
  removed its state without provisioning/resetting the application. These later operations
  also exercise the final session capture/save guards. No review lab was adopted or reset.

Logs and SHA-256:

- `/tmp/jawstack-phase8-final-live.log`:
  `1f56f807949e0a5af9718c767fac6fb19b1f242646b261b356671485a3cbce96`.
- `/tmp/jawstack-phase8-content-up.log`:
  `9e244804ea2fcf3e3ac6d7f97d89e134350afbc038b731c491b88e18cfeb83d6`.
- `/tmp/jawstack-phase8-content-down.log`:
  `3202c41882e2ca90b549c8e94e6bdbd91303e29c57f94c1807540528a3ab6d06`.

These are actual emulator/Docker lifecycle checks, not AWS IAM enforcement, real AWS
deployment, SQS redrive/recovery or a new full Content provision/reset/reprovision proof.
Hobby remains user attestation, not an entitlement audit. Token contents were never printed
or persisted in manifests/evidence. The emulator necessarily holds its startup environment;
no environment dump was taken. Down discards that dedicated emulator's internal state;
service reset remains separately responsible for preserving in-emulator sentinels.

## Integrity and Measurement

The public package code/API/versions and frozen PRD/TDD, task packets, baseline/compatibility
fixtures remain unchanged. Both task packet `--check` commands pass; no A/B run or refreeze
occurred. The lockfile adds only the private importer and Content's workspace link; all
existing resolved package snapshots are preserved. There are no new resolved versions.

Compared with the frozen input set, the changed inputs are now root `package.json`
(`1f52ae77b6abe53a95d11c8326aa746149b6cdbd3026dd90bb9bef8bfb767e34`), workspace filters
(`df27910d26f238901d7bf4c7a7eb729af3f599eccbbccfce13f5cf7b2028076e`) and lockfile
(`26d45a51bf01de5ed73cf4f8aee09b5c988fa48246ea7be34941b9ba58b837ce`). These are
disclosed tooling/dependency-input deviations, not an unchanged-input claim.

Selected consumer protocol remains **1,589 token-lines**. Selected separate lab code is
**1,552 -> 1,404 (-148)**; new private tooling source is separately **864 token-lines**
using the same physical token-line counter, excluding tests/scripts. That growth includes
new profile/identity/locking/network safeguards as well as extracted algorithms and is not
hidden behind the public-package counter. Public source counters remain core 6,298, AWS
runtime 3,082 and CDK 1,028. No net code reduction or agent-speed improvement is claimed.
Phase 9 still must retire app-owned providers; consumer/protocol leverage remains later work.

Read-only probes confirm the memory/managed review API on 4337 remains healthy, and the
review item stays version 3 / draft. No review server/data was restarted/reset. Test-owned
labs are down; existing unrelated named containers/networks remain. No real AWS request,
remote workflow, secret configuration or staging occurred.

Next: Phase 9 completes finite service providers, provisioning/reset and Content lab migration.
