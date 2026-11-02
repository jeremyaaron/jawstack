# Phase 9 Evidence: Finite Service Providers

Status: complete, uncommitted for user review. Review base:
`3c4801f7efa2cf2c65f70f821cbafec92cadf2d1`. No staging, commit, push, tag, version bump,
publication, remote workflow dispatch or real AWS deployment occurred.

## Delivered

- Private `@jawstack/local-lab` now owns finite DynamoDB/stream, EventBridge, SQS,
  Lambda/roles/logs and Content's S3/Scheduler provider operations. Profiles supply bounded
  own-data configurations, explicit supported grants, subscriptions and prebuilt assets,
  not arbitrary SDK/shell callbacks or a general infrastructure DSL. No shared-to-app or
  public-to-private dependency was introduced.
- Complete read-only preflight precedes service deletion. It verifies owner/lab/profile
  identity, function archive/environment/configuration, mapping sources/targets, queue and
  IAM policies, rules/targets, schedules, logs and private unversioned buckets. Listings have
  finite page/item budgets and repeated/missing-cursor checks; bucket keys are collected
  before the first mutation. Unknown/foreign resources and drift refuse cleanup.
- Provisioning captures and verifies every ZIP before remote mutation, refuses named
  collisions rather than adopting resources, orders dependencies and enables schedules
  last. A full post-create audit precedes readiness and atomic private routing publication.
  Optional workflow tags and late-bound owner/profile environment identity support future
  consumers without provider changes. Routing contains resource identities, not secrets,
  and is explicitly not the public runtime's `LocalWorkflowBindings` document.
  Workflow-enabled tags use the lab ID required by that public runtime; transitional
  Content service tags retain their project value until its workflow migration.
- Reset removes owned routing only after full preflight, checkpoints `resetting`, removes
  schedules/mappings before functions and source queues before DLQs, reconciles warm
  containers, verifies absence and saves `starting`. Interrupted resets can resume while
  still checking remaining ownership/configuration. Partial creates retain their state;
  an untagged create/tag crash window is refused, not silently adopted.
- Content now registers pure resource/grant data and archive identities and delegates
  provision/reset through its launcher. Replaced SDK provider algorithms and their
  app-specific fake-provider tests are retired; shared provider tests cover those
  responsibilities. Business handlers, protocol assertions, actual delivery/fault scenarios
  and sentinel checks stay app-owned. Verification adds only safe progress/failure logging,
  not relaxed assertions, deadlines or retries.
- Host SDK construction uses public local transport policy and records only failed
  client/command identity, never raw responses or credentials. Content's current Lambda
  runtime adapter remains app-owned until its scheduled migration. Startup still requires
  an explicitly selected token file and Hobby attestation; other operations do not read it.
  Legacy manifests remain down-only. No new package-guard suppression was added.

Registration and cleanup are documented in the
[private tooling runbook](../../../tooling/local-lab/README.md),
[Content runbook](../../../apps/content-operations/README.md) and
[architecture](../../../apps/content-operations/ARCHITECTURE.md).

## Verification

Focused checks passed on Node 24.16.0 / pnpm 10.21.0: private/app typechecks and lint,
81 private lab tests and all 507 Content tests. The private suite adds 44 tests covering
two independent data profiles, ordered create/reset/reprovision, sentinel survival,
partial failures, archive/configuration/ownership drift, pagination, IAM/queue policies,
routing publication/removal, identity capture and resumable reset. Ordinary tests require
no token, Docker or service listener.

Final-source release verification passed in `/tmp/jawstack-iteration3-phase9-final-verification`,
a second fresh clone overlaid with Git-visible source only. Ignored dependencies/builds, review
data, tokens and manifests were excluded. Installation used `--frozen-lockfile`; there was
no preparatory build. The initial gate stopped at one test-file formatting issue; that was
fixed before the first complete gate. After the workflow-enabled lab-tag correction,
the second clean clone repeated the full gate, including that compatibility assertion.

| Gate                        | Actual Result                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Workspace tests             | 1,329 passed: core 345, AWS runtime 250, CDK 73, Angular 44, CLI 20, generator 7, private lab 81, Work Requests 2, Content 507. |
| Tooling/compatibility       | Eleven Node tests and one frozen compatibility test: 1,341 primary release tests, excluding the generated fixture's two tests.  |
| Typecheck/lint/format/build | Passed.                                                                                                                         |
| Browser boundaries          | Passed; Angular remains 329 modules and zero server imports.                                                                    |
| Package guard               | Zero errors, warnings or info; no new suppression.                                                                              |
| Generated app               | Install/lint/typecheck/two tests, browser/AWS builds, synth and doctor passed; no findings.                                     |
| Package dry runs            | All six passed; public package contents/sizes unchanged from Phase 8.                                                           |

Final log `/tmp/jawstack-phase9-final-release.log`, last written `2026-11-02T04:32:53.725Z`,
SHA-256 `7ac13f8561dcdbd281de6c25cd3187428e37dd76c5aa5b1533184e6fb4d28c2f`.
The install log retains the known prebuild workspace CLI-bin warning; existing browser
externalization/timing and CDK feature-flag notices remain nonblocking. Zero findings above
refers to package guard/doctor, not every tool notice. No UI changed and no new browser
interaction suite was run.

All 27 final changed/new non-Markdown source/config/test files match that clone. SHA-256 of
their sorted `[path, fileSha256]` list:
`679b2a6146c4bd43b70a5974a43eccd172abe5f9ee8cbc27b86cba096cc290c2`.
Subsequent documentation/status edits receive format/link/diff checks.
The current Content profile has no workflow hash, so its service tags and live operations
are unchanged by the separately tested workflow-enabled tag compatibility correction.

## Actual Local Runs

The original Content `local:up`, `local:provision` and `verify:local --confirm-reset`
launchers ran against unique fresh schema-2 labs with the unchanged pinned image/digest
and the explicitly selected existing ignored token file. Hobby remains user attestation,
not an entitlement audit. No token/environment dump was taken and no real AWS was used.

- `phase9`: provisioning and the strict post-create audit passed; the live proof failed
  early with a transport timeout. Its owned emulator/runtimes/network were removed.
- `phase9b`: provisioning, transactional spine and actual HTTP/upload/review/Scheduler/
  publication/notification checks passed. Fault-injection proof stalled; archive-restoration
  failure masked the original error. Its owned resources were torn down.
- `phase9c`: the same standard workflow passed. Added progress logging exposed a transport
  timeout while setting up the fault scenarios. Read-only diagnostics confirmed matching
  verification archive hashes and enabled mappings, but no verification receipts. LocalStack
  reported repeated execution-environment startup timeouts. The 8 GiB host was heavily
  swapping (about 19 GiB swap used); no build/test suite was running alongside this attempt.
  Restoration failed for three workers, but final owned teardown succeeded: zero emulator
  containers, Lambda runtimes and networks; images retained and manifest removed.

Those attempts were not counted as a passing delivery/reset/reprovision gate. After the
user freed memory, a fourth fresh lab, `phase9d`, passed the full unchanged live proof from
`2026-11-02T04:10:46.956Z` through `2026-11-02T04:28:41.607Z` (1,074,651 ms):

- Actual transactional spine and HTTP/upload/review/Scheduler/publication/notification
  paths passed; nine ownership-proven application runtimes were observed.
- Real bundled Lambdas proved transient retry, object-write crash/lease expiry with two
  attempts, exactly three terminal receives, interrupted durable collector/retry/ack,
  operator replay, duplicates, stale generations, ordering, paging and missing services.
  Standard worker archives were restored. Normal visibility stayed 180 seconds; host worker
  invocations and clock advances were both zero.
- S3 conditional creation/private configuration and automatic Scheduler passed. The proof
  queue separately recorded receives `[1, 2, 3]` before durable collection/acknowledgement.
- Shared reset preserved the separately owned sentinel table and nonce, confirmed owned
  service absence and removed all warm runtimes. Reprovisioning then repeated both the
  transactional spine and actual application happy path successfully.
- Final teardown refused the foreign lookalike before stopping owned resources, removed
  running/exited owned fixtures, and confirmed zero emulator containers, Lambda runtimes
  and owned networks. Images were retained; manifest, routing and lock were removed.

No application assertion, function timeout, SQS visibility, retry/receive limit, fault
deadline or emulator setting was weakened. The passing retry after memory was freed is
consistent with the earlier observed host/resource contention, not a concealed test fix.
This is actual local-transport evidence, not real AWS deployment or IAM enforcement.

Sanitized logs and SHA-256:

- `/tmp/jawstack-phase9d-up.log`:
  `20460481aaaf63fe00b3311bf575c800e147a6a93dba3c630c2799117f2daa05`.
- `/tmp/jawstack-phase9d-provision.log`:
  `fab1ea12302c3a30ab6a461580f04b211bfe404414eb77cf0056f89e8422663a`.
- `/tmp/jawstack-phase9d-live-proof.log`:
  `5e81a2d47033016599289a8a2d54d68a0696b1acaf97d22b633f045d86f5fc5c`.
- Ignored `apps/content-operations/.localstack/phase9d-evidence.json`:
  `ac0cc586dc87235204df66b0a0f969ff0a71eede93e5fbd66d35983b84da3fcf`.

## Integrity and Measurement

Public package APIs/versions, frozen PRD/TDD, task packets, inventory, baseline and
compatibility inputs remain unchanged. Lockfile changes only add existing resolved SDK
versions to the private importer and move IAM/Lambda from dev dependencies; no new
resolution is required; structured YAML comparison confirms every resolved package and
snapshot is unchanged. Both frozen task packet `--check` commands pass; no task exercise,
post A/B or refreeze occurred.

Root `package.json` (`1f52ae77b6abe53a95d11c8326aa746149b6cdbd3026dd90bb9bef8bfb767e34`)
and workspace filters (`df27910d26f238901d7bf4c7a7eb729af3f599eccbbccfce13f5cf7b2028076e`)
remain at Phase 8's disclosed deviations from the baseline. The lockfile now hashes to
`a0db93eb5d01ef9dcb76ef705c6e5416fdf99c771d2a35bad3c67fec2799beb9`; its private SDK
importer changes are an additional disclosed dependency-input deviation.

Selected consumer protocol remains **1,589 token-lines**. Selected separate lab code is
**1,404 -> 443 (-961)** relative to Phase 8 (frozen baseline: 1,552). Private tooling source
grows **864 -> 2,187** token-lines, measured separately with the same counter, excluding
tests/scripts. Public source counts remain core 6,298, AWS runtime 3,082 and CDK 1,028.
This is provider retirement plus stronger lifecycle checks, not evidence of net code
reduction, agent-speed improvement or completion of the later consumer migrations.

The interactive memory review server/data remain outside these disposable lab operations.
Read-only probes confirm its API is healthy and the maintained review item remains version
3 / draft. Existing unrelated named containers remain untouched.

Next: Phase 10 migrates Content command/record persistence while retaining one active
legacy delivery owner until Phase 11. Public workflow-binding assembly accompanies those
consumer migrations; this phase's private routing inventory does not replace that contract.
