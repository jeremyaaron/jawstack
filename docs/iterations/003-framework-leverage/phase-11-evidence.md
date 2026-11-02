# Phase 11 Evidence

Status: complete. Delivery/recovery migration, clean-release, memory/browser and the
complete normal-bound actual local failure/reset/reprovision/teardown gate passed.

Base: `c93df291686896d8c6d50bff4e8ce30ca569fb35`. No commit, tag, publication, version
change, remote workflow dispatch or real AWS deployment is part of this phase.

See the [migration ledger](leverage/phase-11-migration.md) for ownership and accounting.
Frozen PRD/TDD, inventory, baseline and compatibility fixtures are not rewritten.

## Implementation

Content delegates failure storage/history/replay, SQS validation/acknowledgement and memory
pumping to public adapters. Business materialization, notifications, immutable artifacts,
uploads, publication authority/fences, recurring jobs and operator policy remain app-owned.
Publication generic replay remains forbidden before equivalent-request lookup.

Shared validation rejects incomplete two-field replay metadata and batches exceeding the
declared size of one before any effects. Tests now use realistic SQS source/region fields,
complete targeted metadata and durable replay requests. Marker capacity defers new work
instead of evicting unexpired markers. Existing business assertions and bounds remain.

## Verification

Node 24.16.0 / pnpm 10.21.0. All 509 Content tests pass. Three new core adapter
tests cover captured bindings, canonical replay/completion, invalid ports/capacities and
non-evicting marker backpressure. The new AWS parse-only test checks zero SDK reads/effects
and demonstrates that parse success is not durable replay authorization.

All 30 memory browser tests passed in 8.3 minutes, desktop 1440x900 and mobile 390x844.
Both automatic-publication screenshots were visually inspected for text fit, controls,
section spacing and rendered media. Isolated servers used 4436/4437, not the review server.

Final-source verification used fresh clone
`/tmp/jawstack-iteration3-phase11-verification-C20Eh2`, overlaid with Git-visible source
only. No ignored dependencies/builds, tokens, manifests, review data or browser artifacts
were copied. Frozen install and `pnpm verify:release` passed with tests before builds:

| Gate                              | Result                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Workspace tests                   | 1,341: core 353, AWS runtime 252, CDK 73, Angular 44, CLI 20, generator 7, private lab 81, Work Requests 2, Content 509. |
| Tooling/compatibility             | Eleven Node tests plus one frozen compatibility test; 1,353 primary tests, excluding the generated fixture's two tests.  |
| Typecheck/lint/format/build       | Passed, including package declarations.                                                                                  |
| Browser package boundary          | 329 Angular modules, zero server imports.                                                                                |
| Package guard/doctor              | Zero findings; no added suppressions.                                                                                    |
| Generated consumer/package checks | Lint/typecheck/tests/build/synth/doctor and six package dry runs passed.                                                 |

All 37 changed/new non-Markdown source/config/test files match the final clone.
The SHA-256 of their sorted `[path, fileSha256]` list is
`0e722d3e0a907f9aa5176d9842f2dc649a18a03119967bd5c0983ece1298914d`.
Subsequent status/evidence edits are Markdown only. Known prebuild CLI-bin,
browser externalization/timing, color-environment and CDK flag notices are nonblocking.

## Actual Local Proof

Both actual local browser workflows passed in 4.2 minutes, on desktop/mobile through
HTTP/upload/review/Scheduler/stream/bus/queue/Lambda/S3. The API reported external-worker
processing; no host pump was started. Both publication screenshots were visually inspected.
The complete normal-bound failure/reset/reprovision/teardown gate passed from
`2026-11-02T12:52:43.882Z` through `2026-11-02T13:11:43.865Z`
(1,139,983 ms, 19 minutes), sequentially after release/browser gates.
Fresh schema-2 lab `phase11` is provisioned on the unchanged pinned ARM64 LocalStack
image, using the existing ignored token file and user-attested Hobby setting. No token or
environment dump was taken; no real AWS was used.

Profile hash:
`2d2d7675c608d5d7955927758894a261f7b4e46616ec7f862fe483fd392718e4`.

| Application Archive | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| spine               | `0ec54cc8ab9fc78d5d2aaa4bdd4b5694f20a31d97772b016e38ec396e4bde8a7` |
| publication         | `4717372e110dcc65ad89b5672422ba39370ce14f2ed83fd8fefe4cca6f90dd6a` |
| jobs                | `40740be6713008570ee1f56024993f2107414f56193d619b2b80afa5cd7b1015` |
| recovery            | `d2869e5447860c35971fc10a5e69eacd455d49e3fc30f3de957adb6e5b05db2e` |

Verification-only archive:
`e7d4ab0821e2a92234d146462d771de2676832e2121382eb3ce647a47aba9253`.

- Transactional spine and actual HTTP/upload/review/Scheduler/publication/notification
  Lambdas passed, with eight ownership-proven warm runtimes observed.
- Real transient retry, crash after object write, lease expiry/two-attempt recovery and
  exactly three terminal receives passed. Immutable bytes stayed identical.
- Interrupted collection retained a durable pending row without an acknowledgement marker;
  automatic collector redelivery reconciled it and acknowledged the DLQ. CLI replay,
  duplicates after marker loss, obsolete generations, late collectors, ordering, paged
  operations and missing-service failures passed. Standard archives were restored.
- Visibility stayed 180 seconds; host worker invocations and clock advances were both zero.
  S3 conditional creation/private configuration, automatic Scheduler and the separate proof
  queue's receives `[1, 2, 3]` with durable collection/acknowledgement passed.
- Reset preserved the unrelated sentinel and payload, removed owned service resources and
  all warm runtimes. Reprovisioning repeated both the transactional spine and real app path.
- Final teardown refused the foreign lookalike before stop, removed running/exited owned
  fixtures and confirmed zero emulator containers, Lambda runtimes and owned networks.
  Images were retained; manifest, routing and lock were removed. Unrelated Docker fixtures
  and the existing review server/dataset were not changed.

Read-only diagnostics during the collector wait observed the intentional injected
interruption and pending ledger; they did not invoke handlers, alter clocks or change state.
No application assertion, retry/receive/visibility bound, function timeout, fault deadline
or emulator setting was weakened. This proves local transport behavior, not real AWS IAM
enforcement or production readiness.

Sanitized logs/evidence and SHA-256:

| Artifact                                                            | SHA-256                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `/tmp/jawstack-phase11-install.log`                                 | `79bda6e125ba3893f4a40b0728a49a4237c7f6e8b5c45c2f33149524d2182786` |
| `/tmp/jawstack-phase11-release.log`                                 | `e43bbe10ecd69f1b683740a1494bf797ea6b6f4c275614dea79f75f012fcaafc` |
| `/tmp/jawstack-phase11-browser.log`                                 | `09578ba2abb964b60cca318e04ce8611afa3223b9f48271477ac7f250f240320` |
| `/tmp/jawstack-phase11-local-browser.log`                           | `14ec271d2daf6888d873ae6edfa8c7f8356c383884e73e0bf9e58abe29bc1a2c` |
| `/tmp/jawstack-phase11-up.log`                                      | `07744e0954dbc120b2776d1e8cc214a25380e2cb160ca4824f1eca32adbe6ce4` |
| `/tmp/jawstack-phase11-provision.log`                               | `fab1ea12302c3a30ab6a461580f04b211bfe404414eb77cf0056f89e8422663a` |
| `/tmp/jawstack-phase11-live.log`                                    | `505073ffe70fce50a7839c0c4e63a296fabab101866a3bbcf8dba0e371c6353e` |
| Ignored `apps/content-operations/.localstack/phase11-evidence.json` | `397a8cf1c0e70aed02b39eb8b8eddb8b906dc5331523b7cb67865f7925022dc8` |

## Integrity and Measurement

The working post inventory counts **1,589 -> 948 selected protocol token-lines (-641,
40.3%)**. Separate lab remains **443**. This intentionally conservative count includes
the full guarded SQS/publisher assembly and moved event policy, not only changed statements.
The final 50% threshold is not yet met; the whole-consumer audit and paired post exercises
remain unfinished, not silently declared successful.

From Phase 10, core grows **6,313 -> 6,380** and AWS runtime **3,099 -> 3,103** token-lines.
CDK stays **1,028** and private lab **2,187**. Seven additional core function exports,
storage-spec parse/fact methods and the SQS parse-only method are additional API burden,
disclosed rather than hidden. Complete workflow factories remain the default for new apps.

The migration changes synthesized collector construct ownership/logical IDs, not physical
names or transport/log bounds. This is synthesis-only validation, not an attempted update
of an existing AWS deployment.

The review API remained healthy and its maintained item remained version 3 / draft.
Both frozen task packet checks, final formatting, Markdown links and diff checks pass.
No post-extraction A/B exercise was executed or baseline refrozen. Changes remain
uncommitted for user review.
