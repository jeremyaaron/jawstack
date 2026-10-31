# LocalStack Feasibility Evidence

## Phase 0: Event Spine

Observed on October 31, 2026. The Phase 0 event spine, reset, and restart proof passed.
This section preserves the Phase 0 partial result. The Phase 1 section below records the
subsequent passing result for the complete two-phase feasibility gate.

### Environment

| Item               | Observed Configuration                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host               | macOS ARM64, 8 GiB physical memory.                                                                                                                       |
| Docker             | Engine 27.3.1, Compose v2.30.3-desktop.1; ARM64 VM with approximately 8 GB memory and 8 CPUs.                                                             |
| Emulator           | `localstack/localstack:2026.10.0`                                                                                                                         |
| Image digest       | `sha256:aa5632e041ca54ff61a0a25e17b1c898b09a1eb7f611bfc05f73ef53b7266872` (multi-architecture manifest).                                                  |
| ARM64 image digest | `sha256:5faf7e4563e6219ee39e844e28a7174f110d12e97d58a2d84eb0c41dd6ebae6b` (registry metadata).                                                            |
| Entitlement        | Hobby, confirmed by the user and explicitly attested in local configuration; no automated license-tier audit. No paid trial was activated by the harness. |
| Credentials        | Explicit `test`/`test` SDK credentials; no real AWS credentials/profile loaded. LocalStack token passed only to the emulator.                             |
| Networking         | Host `127.0.0.1:4566`; Lambda `localstack:4566` on the dedicated Compose network.                                                                         |
| Lambda             | Bundled ESM Node 22 handlers, requested architecture ARM64, 256 MiB, 30-second timeout, reserved concurrency 2.                                           |
| Stream/queue       | DynamoDB new/old images; stream batch 10; SQS batch 1, maximum concurrency 2, visibility 180 seconds, retention 4 days.                                   |
| Logs/data          | Seven-day Lambda log retention; local data discarded on emulator recreation; images retained.                                                             |

The pinned image was inspected through Docker after startup. The host and Lambda endpoints
both passed the final outgoing HTTP destination guard during real service requests.

### Observed Results

| Check                              | Result | Evidence                                                                                                                                                   |
| ---------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dedicated startup/readiness        | Passed | Owned Compose container/network started on loopback using the pinned image.                                                                                |
| Transactional command              | Passed | `spineProof.create` used public JawStack executor/repository/unit-of-work APIs. State, activity, projection, outbox, and idempotency records were checked. |
| Command replay                     | Passed | Equivalent replay returned the original stored success envelope; only one state version/activity record was created.                                       |
| Actual DynamoDB stream invocation  | Passed | Bundled dispatcher Lambda received committed stream records; no substitute direct invocation was made.                                                     |
| EventBridge -> SQS -> Lambda       | Passed | Source/type rule delivered the committed event to the real worker, which conditionally wrote a receipt.                                                    |
| Correlation and publication status | Passed | Receipt matched the command/correlation/event; the matching outbox record became `PUBLISHED`.                                                              |
| One logical worker receipt         | Passed | Strongly consistent query found one receipt for the proof resource.                                                                                        |
| Ownership-checked reset            | Passed | Functions, event mappings, event bus/rule/target, table, queue, role/policy, and logs were removed; reprovisioning and another proof succeeded.            |
| Full teardown/restart              | Passed | Compose down removed the owned emulator/network and its Lambda containers; a new startup/provision/proof cycle succeeded.                                  |
| Final teardown                     | Passed | Owned lab stopped after verification; no owned runtime containers were left running.                                                                       |

Representative successful runs:

- `2026-10-31T16:13:14.038Z`: proof completed in 5.936 seconds.
- `2026-10-31T16:16:24.176Z`: after reset/reprovision, proof completed in 18.210 seconds.
- `2026-10-31T16:19:38.870Z`: after full teardown/restart/reprovision, proof completed in
  16.800 seconds; resource `proof_7585a9c8-9a35-4185-b250-69d3b57a7c78`, correlation
  `f8e743f3-2058-4634-ad4f-a741a637a183`, event `evt_mvwlwd53_b7lhi0c0`.

These are command-to-observed-result durations, not a latency benchmark. The first runtime
image pull and provisioning take additional time. Local successful-run metadata is saved
under the app's Git-ignored `.localstack/` directory; this file preserves the reviewed summary.

### Safety and Credential-Free Coverage

At Phase 0 completion, the app's unit suite contained 31 tests. It checked runtime/identifier
validation, rejected AWS credential/profile/role/endpoint settings, final transport guards,
dummy client credentials, finite SDK retries, and local queue URL validation. Instrumented
unsafe-destination tests reject before the base network transport is called.

Ownership tests cover a foreign function, a foreign table discovered after owned functions,
pre-existing queue collision, and an unexpected mapping. They assert refusal before any
delete/create takeover. Additional tests check the public command transaction, idempotent
replay, unauthorized input, bounded readiness polling, and missing-resource error handling.

Tests/builds/typechecks do not read the token file, start Docker, or contact AWS. A raw token
without its dotenv assignment was rejected during setup; its value was not printed. A first
verification assertion compared JSON key insertion order; it was corrected to structural
equality before the successful recorded runs. Neither issue was an emulator service limitation.

The full `pnpm verify:release` gate also passed with the emulator stopped: 149 workspace
unit tests, typecheck/lint/build, pkg-guard with zero findings, isolated generated-app
installation/typecheck/tests/build/synth/doctor, and six package dry runs. Documentation
formatting, local links, and diff checks passed. No public framework package was changed
or versioned in this phase.

### Reproduction

Follow the [application README](../../../apps/content-operations/README.md). The observed
sequence was:

```sh
pnpm --filter content-operations run local:up
pnpm --filter content-operations run local:provision
pnpm --filter content-operations run verify:local
pnpm --filter content-operations run local:reset --confirm-reset
pnpm --filter content-operations run local:provision
pnpm --filter content-operations run verify:local
pnpm --filter content-operations run local:down
pnpm --filter content-operations run local:up
pnpm --filter content-operations run local:provision
pnpm --filter content-operations run verify:local
pnpm --filter content-operations run local:down
```

The commands never called `cdk deploy`, directly invoked the worker as proof, or manually
published a replacement event. Lambda ZIPs and local service resources were provisioned
through explicit guarded SDK clients.

## Phase 1: Complete Feasibility Gate

Observed on October 31, 2026, on the same pinned image, Docker runtime, ARM64 architecture,
dummy credentials, and user-attested Hobby entitlement described above. No trial activation,
real AWS credentials, or cloud deployment was used. Decision: **go** for the planned local
integration architecture, not a claim of production readiness or full AWS parity.

### Test Profile

The lab now has four Lambda entrypoints: outbox dispatcher, artifact/receipt worker,
failure collector, and Scheduler target. Worker and collector use 5-second timeouts with
30-second queue visibility, batch size 1, maximum concurrency 2, and three source receives
before redrive. Dispatcher and Scheduler target retain 30-second timeouts. The DLQ retains
messages for fourteen days. All function logs retain seven days.

These shorter, explicitly bounded worker timings are a feasibility-test profile, not a
change to the later application's 30-second/180-second runtime design. S3 is configured
unversioned with bucket-owner-enforced ownership and all four public-access-block flags.
The rate schedule is disabled outside the verification scenario and disabled in `finally`.

### Observed Results

| Check                                         | Result | Evidence                                                                                                                                                                                                                            |
| --------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spine plus actual worker S3 output            | Passed | State/activity/projection/idempotency/outbox and the worker receipt were checked, along with exact artifact bytes and digest from S3.                                                                                               |
| Concurrent conditional S3 creation            | Passed | Two `IfNoneMatch: *` writes converged to one creator and one stored object. Matching readback succeeded; different bytes were rejected without overwrite.                                                                           |
| Automatic Scheduler target                    | Passed | An enabled `rate(1 minute)` schedule invoked the bundled framework Scheduler adapter, issued a normal transactional proof command, and produced a downstream S3/worker outcome. No manual trigger or direct Lambda invoke was used. |
| Bounded failure and actual redrive            | Passed | An injected failing command traversed the real stream/bus/queue path. Durable attempt rows recorded receive counts exactly `[1, 2, 3]`; no success receipt or successful-worker marker was produced.                                |
| Durable DLQ collection before acknowledgement | Passed | The collector stored the original event and its correlation, wrote its completion marker, and the DLQ became empty. Credential-free tests also prove a failed durable write throws before a processed marker/acknowledgement.       |
| Unrelated-resource sentinel                   | Passed | A separately owned table and nonce survived deletion of all known owned service resources. The verifier then removed only its exact sentinel after checking its independent owner and contents.                                     |
| Cleanup completeness                          | Passed | Functions, logs, mappings, table, queues/DLQ, roles/policies, bus, bucket, schedule/group were absent. The strengthened run also observed zero old Lambda containers after reset.                                                   |
| Reprovision                                   | Passed | The lab was provisioned again after the sentinel check; a new transactional spine and worker S3 proof passed.                                                                                                                       |

Successful complete runs:

- Started `2026-10-31T16:36:04.114Z`; duration 131.335 seconds; `decision: go`.
- Started `2026-10-31T16:40:27.442Z`, completed `2026-10-31T16:42:28.691Z`; duration
  121.249 seconds; `decision: go`, including the explicit Lambda-container cleanup check.

For the latter run, the automatic schedule used run ID
`17f29926-6dba-4e1a-89f2-d49fc5454c95`; the failing resource was
`failure_76ccf19c-a227-4c4e-912b-fac193fe3590` and the independent sentinel table was
`jawstack-content-ops-dev-sentinel-19c0ff79`. The post-reset proof resource was
`proof_2bd16959-ec51-48cd-8403-da564c08ee56`.

### Verification and Safety

At Phase 1 completion the app had 42 credential-free tests, adding conditional-write conflict and error
handling, failed receive recording, durable-before-acknowledgement collection, deduplication,
wrong-source rejection, DLQ URL validation, foreign-bucket refusal, bounded/repeating
cleanup pagination, refusal to enable an unexpected target, and disable-on-enable-error cleanup.

Provisioning preflights the added bucket, DLQ, schedule group, roles, and function names
before creating/adopting resources. Reset completes all ownership/target checks before
stopping the schedule and deleting resources. It refuses enabled bucket versioning and
excessive/broken listings rather than claiming incomplete object cleanup succeeded.

S3 creation/tagging is not atomic. An interruption before the ownership tag is written
causes fail-closed reset; recreating the owned ephemeral emulator is the recovery path,
not forcibly adopting an untagged bucket. The service-resource sentinel survives reset;
whole-container teardown intentionally discards all data in that dedicated emulator.

The complete gate now requires explicit reset consent:

```sh
pnpm --filter content-operations run local:up
pnpm --filter content-operations run local:provision
pnpm --filter content-operations run verify:local --confirm-reset
pnpm --filter content-operations run local:down
```

The token remains outside Git/logs. Verification writes running/passed/failed evidence and
an explicit go/no-go decision instead of leaving an old pass as the result of a failed gate.

`pnpm verify:release` passed: formatting, workspace typecheck, all 160 unit tests (including
the 42 harness tests), lint, builds, pkg-guard with zero findings, isolated generated-app
install/typecheck/tests/build/AWS bundle/synth/doctor, and all six package dry runs. Local
Markdown links and `git diff --check` also passed. Final teardown left no owned containers
or Docker network. No real AWS deployment, package version change, release, or commit was made.

## Phase 3: DynamoDB Paged Queries

Observed on October 31, 2026, using the same pinned LocalStack `2026.10.0` image/digest,
ARM64 architecture, Docker runtime, local-only clients, and user-attested Hobby tier.
The complete `feasibility-and-paged-queries` gate started `2026-10-31T17:28:42.904Z` and
completed `2026-10-31T17:31:14.857Z` in 151.953 seconds with `decision: go`.

Paging run ID: `32a79455-59f1-4093-a3ba-b1e9abaf1519`; projection partition selected by
`spineProof.paging.32a79455-59f1-4093-a3ba-b1e9abaf1519`.

| Check                        | Observed Result                                                                                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Large multi-page dataset     | 260 projection records with 8,192-byte payloads, tied timestamps, and both existing sort-suffix forms. A Query requesting 200 items returned 123 matching items plus continuation, exercising a real service-shortened page. |
| Empty filtered page          | An auxiliary non-projection record produced an empty one-item-limit page with a real `LastEvaluatedKey`. Continuing returned all 260 logical projection records without loss.                                                |
| Range/direction parity       | Eight cases covered ascending/descending full reads, exact half-open boundaries within timestamp ties, equal bounds, and an empty upper range. Complete ordered results matched memory.                                      |
| Activity parity              | Seventeen tied activity records were read in activity-ID order over six pages with a limit of three; complete results matched memory.                                                                                        |
| Transactional sort move      | The public DynamoDB and memory units of work deleted the previous projection key and wrote its replacement. A strongly consistent Get confirmed the old physical key was absent; subsequent complete reads agreed.           |
| Transactional partition move | Explicit old-key deletion and a replacement in the approved partition left the old list without that item and the new partition with exactly one item. Both adapters agreed.                                                 |
| Deleted continuation key     | A descending page boundary row was deleted transactionally. The original service cursor still continued correctly; remaining ordered results matched memory.                                                                 |
| Full prior gate              | Transactional spine/S3 proof, conditional object duplicates, automatic Scheduler invocation, real three-receive failure/redrive and durable DLQ collection passed again.                                                     |
| Reset and reprovision        | Unrelated-owner sentinel `jawstack-content-ops-dev-sentinel-aae57d23` survived, owned resources and warm Lambda containers were absent, and post-reset spine/S3 proof `proof_e892140f-c578-4419-b6c2-2b7cce3c2e48` passed.   |
| Final teardown               | `local:down` passed; no owned containers or Docker network remained.                                                                                                                                                         |

The paging fixture uses only the existing owned table and public key/item mappers. Batch
writes are bounded to 25 items and three attempts; memory projections are seeded through
its public unit of work. It does not introduce a second provisioner or leave service data
outside the existing reset boundary. The token remains Git-ignored and undisplayed.

Credential-free coverage now includes fourteen shared query contract cases per adapter,
additional SDK continuation/shape/progress tests, version-1 SHA-256 cursor compatibility,
and bounded fixture writes. Current package counts are 111 core tests, 76 AWS runtime
tests, and 45 consumer tests. `pnpm verify:release` passed with all 281 workspace unit tests,
typechecking, lint, builds, pkg-guard (zero findings), isolated generated-app install/
typecheck/tests/build/AWS bundle/synth/doctor, and all six package dry runs. Formatting,
local Markdown links, and `git diff --check` also passed. No dependencies, versions,
workflows, package release, commit, or real AWS resources were changed/created.

This proves SDK-provisioned local query behavior, not a deployment, snapshot isolation,
production authorization/IAM, or arbitrary application filtering. Existing exclusions below
remain unchanged. Fixed item-kind filtering is not a user-supplied search expression.

## Phase 7: Scoped Consumer Transactions

Observed on October 31, 2026, using the same pinned LocalStack `2026.10.0` image/digest,
ARM64 architecture, Docker 27.3.1, guarded local-only clients, and user-attested Hobby tier.
The complete `feasibility-paging-and-scoped-transactions` gate started
`2026-10-31T19:22:33.814Z` and completed `2026-10-31T19:25:28.478Z` in 174.664 seconds,
with `decision: go`. Scoped run ID: `82f26079-a9fb-481a-9d36-f9a54acebe77`.

| Check                          | Observed Result                                                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Concurrent equivalent commands | Six creates and six edits per adapter returned exactly one stored response per command, including original metadata. Only one create activity was persisted.                                                                         |
| Scope and conflicting reuse    | The same key worked for separate subjects and for create/edit command scopes. A changed payload in an existing scope was rejected.                                                                                                   |
| Logical expiry                 | A seven-day server-clock advance allowed a different target to reuse the key while its physical record remained in DynamoDB; subsequent retries returned the replacement response. No TTL deletion was needed.                       |
| Auxiliary rollback             | A pre-existing create-only command receipt caused the entire create to fail: no primary state, activity, list projection, or idempotency record appeared.                                                                            |
| Primary condition rollback     | A stale expected version rejected a composed commit; state stayed at version 3, its projection survived, and the version-4 receipt was absent.                                                                                       |
| Projection moves               | Submit/reopen removed obsolete status/due rows. Separate synthetic commits moved exact sorts and partitions, coalescing duplicate physical sort aliases. Strong physical-key reads confirmed old DynamoDB sort/due keys were absent. |
| Adapter parity                 | Both memory and live DynamoDB passed the same scoped scenario; no stale user mutation was retried.                                                                                                                                   |
| Earlier gates                  | Stream/outbox/bus/queue/S3 spine, 260-row paging (123-item service-shortened first page), automatic Scheduler, actual worker receives 1/2/3 and DLQ collection, sentinel-safe reset, and reprovisioned spine all passed again.       |

The consumer commands were dispatched directly against the owned table. This proves
consumer persistence, not deployed editorial HTTP/workers/UI. A synthetic single-resource
commit isolates sort/partition mechanics; it is not an added user-facing content command.
Fixture data was discarded by the owned reset. Final `local:down` removed the owned emulator
and network; images were retained. No real AWS resource was created or contacted.

Credential-free verification: all 170 consumer tests, including 29 new transaction tests,
and `pnpm verify:release` (455 workspace tests, format/typecheck/lint/build, zero pkg-guard
findings, isolated generated-app verification, six package dry runs). Unit contracts also
cover the exact 60/61-action budget, resource-type isolation, ambiguous successful SDK
responses, and a winner committing before a stale decision. These are not claims of
AWS-equivalent contention, IAM enforcement, or arbitrary throughput.

## Phase 8: Attachments and Immutable Objects

Observed on October 31, 2026, using the same pinned LocalStack `2026.10.0` image/digest,
ARM64 architecture, guarded local-only clients, and user-attested Hobby tier. The final
`feasibility-paging-scoped-transactions-and-assets` gate started
`2026-10-31T19:52:15.892Z` and completed `2026-10-31T19:55:22.937Z` in 187.045 seconds
with `decision: go`. An earlier complete run also passed in 169.287 seconds; the final run
followed the independent stream-cancellation deadline fix.

Asset run ID: `70c30ad1-eae0-4a3e-b2e7-4608d9b0a101`.
Content ID: `d30cb76f-70e9-41ef-accb-038f66fdee93`.

| Check                             | Observed Result                                                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Real object/database split        | The service wrote and read back an actual private S3 object, then injected a failed completion dispatch. Strong DynamoDB reads still showed the slot pending, not ready. This was a controlled interruption, not a process-crash test.                 |
| Retry recovery                    | Different bytes at the generated existing key were rejected without overwrite. The original bytes subsequently completed the authoritative slot with their verified SHA-256. A matching ready retry left the content version unchanged.                |
| Concurrent duplicate object calls | Four conditional duplicate calls against the already-existing key returned its same digest. Listing the exact asset prefix found one logical original object. This is duplicate-write convergence, not a claim that four physical creations succeeded. |
| Submission and approval           | Pending submission was rejected. Ready submission froze the object reference/digest; approval succeeded, and the upload service then rejected another upload against approved content.                                                                 |
| Retirement retention              | Reopen/removal retained a full removed tombstone and the same readable verified object, preserving the historical approved reference. No object-store deletion operation was invoked.                                                                  |
| Logical expiry                    | Advancing the injected server clock one hour rejected a pending upload before object creation. The internal expiry command emitted an expired tombstone; listing its exact key confirmed no object existed.                                            |
| Keys and signatures               | A path-like filename was rejected. The generated PNG key round-tripped exact bytes; JPEG/PDF signature fixtures also round-tripped through the private S3 adapter. These are signature checks, not full media-format decoding or sanitization.         |
| Earlier integration gates         | Event spine and S3 worker output, 260-row paged queries, scoped transaction/expiry/rollback parity, automatic Scheduler, actual receives 1/2/3 and DLQ collection, sentinel-safe reset, and reprovisioned spine all passed again.                      |
| Cleanup                           | Owned reset removed the fixture objects/table while preserving an unrelated sentinel and its nonce. No owned Lambda containers remained after reset. Final `local:down` removed the owned emulator/network; cached images were retained.               |

Credential-free verification added 51 tests: 27 domain/upload/materializer tests and 24
memory/S3 object-store contracts. All 221 consumer tests and `pnpm verify:release` passed
(506 workspace tests, format/typecheck/lint/build, zero pkg-guard findings, isolated
generated-app verification, and six package dry runs). Unit checks cover the exact 10 MiB
boundary, unsafe endpoint/credential rejection with zero SDK sends, corrupt metadata/bytes/
streams, 409 retry bounds, malicious filenames, cross-content IDs/forged roles, 10-active/
32-retained slot limits, optimistic completion races, two-upload admission, and deadlines
even for an async producer that never yields or completes cleanup.

The application now has content-authoritative attachment commands, immutable object stores,
and internal asset snapshot primitives. The live proof calls the transport-independent
service directly; it is not an HTTP deployment or a running asset materializer. HTTP,
download response hardening, worker orchestration, automatic expiry/orphan jobs, IAM
enforcement, real AWS, media decoding, and antivirus remain outside this evidence. Verified
removed bytes are conservatively retained until reset; no production retention guarantee
or automatic deletion is claimed.

## Phase 11: Recoverable Publication Artifacts

Observed on October 31, 2026, with the same pinned LocalStack image/digest, ARM64 runtime,
guarded local-only clients, and user-attested Hobby tier. The complete
`feasibility-paging-transactions-assets-and-publication` gate started
`2026-10-31T21:06:23.935Z` and completed `2026-10-31T21:09:50.102Z` in 206.167 seconds,
with `decision: go`.

Publication run ID: `5aca0a7e-c77e-4fe4-89c0-08f263210f48`.
Content ID: `14ed302e-472f-4d7b-9597-b20bdf937dd4`.
Artifact SHA-256: `d5f5ed1df8adf4309d6aac26b1ecf29df016e2334f0e88ccfe983758d8778311`.

| Check               | Observed Result                                                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Object/domain split | The shared publisher claimed through real DynamoDB commands and wrote/read back actual immutable S3 bytes. An exact-operation injected process interruption after object creation left the domain claim running and artifact metadata unset. |
| Competing delivery  | An early duplicate threw `resource.conflict`, not a successful processed result.                                                                                                                                                             |
| Lease recovery      | Advancing the injected clock exactly 90 seconds allowed a fresh claim to recover the matching object and complete the domain. Query history contained expired and succeeded attempts.                                                        |
| Stable artifact     | The completed digest matched exact serialized bytes, and listing the content publication prefix found one logical artifact. A later duplicate left the completed content version unchanged.                                                  |
| Corruption          | A second owned exact-key fixture had correct metadata but altered bytes. Publication terminalized with `artifact.mismatch`; direct S3 readback confirmed the existing bytes were not overwritten.                                            |
| Earlier gates       | Actual stream/bus/queue/Lambda spine, paging, scoped transactions/rollback, attachments, automatic Scheduler, receives exactly 1/2/3 with durable DLQ collection, sentinel-safe reset, and reprovisioned spine all passed again.             |
| Owned reset         | Fixture objects/table were removed while the separately owned sentinel and its nonce survived. No owned Lambda containers remained after reset.                                                                                              |

This consumer scenario runs the shared service directly on real DynamoDB/S3. It is not
deployed editorial SQS/Lambda evidence. The separate spine still proves actual managed
delivery without substitute direct invocation. The newly bundled `publication.zip` entrypoint
and framework marker ordering are credential-free contracts; application queue/mapping/
permission provisioning remains Phase 20/21. Clock advancement models lease expiry without
waiting 90 wall-clock seconds; injection models process interruption, not an OS kill.
No real AWS resource was created or contacted.

Final `local:down` removed the owned emulator and network; filtered Docker container/network
inventories were empty. Credential-free verification added 28 tests (331 consumer/616
workspace tests total), including bundle exports, marker gaps/expiry, whole-batch validation,
stale-worker fencing, stable serialization, and memory/S3 corruption/conditional-write
contracts. `pnpm verify:release` passed with zero pkg-guard findings, isolated generated-app
verification, and six package dry runs. No dependencies, public package versions, or
framework implementations changed.

## Phase 12: Due Jobs, Reminders, and Orphan Cleanup

Observed on October 31, 2026, with the same pinned LocalStack `2026.10.0` image/digest,
ARM64 runtime, guarded local-only clients, and user-attested Hobby tier. The complete
`feasibility-paging-transactions-assets-publication-and-jobs` gate started
`2026-10-31T21:23:57.378Z` and completed `2026-10-31T21:27:33.732Z` in 216.354 seconds,
with `decision: go`.

Jobs run ID: `4ab59d5c-fb6c-480e-bef0-2ec6b9a2d2b8`.

| Check                  | Observed Result                                                                                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publication overlap    | Two concurrent ticks used conditional DynamoDB checkpoint leases; one returned busy and only one requested publication. Strong content state became publishing.                                                                                      |
| Review continuation    | A one-candidate tick persisted its cutoff/cursor. A freshly composed job/store resumed the second review, and another pass emitted no same-UTC-day reminder. Both roots retained the authoritative reminder day.                                     |
| Abandoned slot expiry  | A pending draft slot with an actual S3 object expired through the internal content command at its logical one-hour deadline.                                                                                                                         |
| Retention and deletion | Immediate cleanup retained the young orphan. After advancing the injected clock another 24 hours, the exact old object was conditionally deleted; head returned absent and the expired slot tombstone remained.                                      |
| Lease takeover         | A live lease refused a second acquisition. At exactly 30 seconds, a successor acquired a different token. A stale owner using its original time could not overwrite/release the successor checkpoint.                                                |
| Earlier gates          | Actual stream/bus/queue/Lambda, paging, scoped transaction/rollback, attachments, publication recovery/corruption, automatic Scheduler, actual receives 1/2/3 and durable DLQ collection, sentinel-safe reset, and reprovisioned spine passed again. |
| Cleanup                | Owned reset preserved the independently owned sentinel and its nonce, and left zero owned Lambda containers. Final `local:down` removed the emulator/network; filtered Docker inventories were empty.                                                |

This is direct shared-job execution against real DynamoDB/S3, with logical clock advancement
instead of waiting one hour/day. It does not deploy the consumer Scheduler targets or prove
their IAM/grants. The existing separate rate schedule still fired automatically; no direct
Lambda trigger was substituted for that transport proof. `jobs.zip` uses the public Scheduler
adapter but remains a bundled, credential-free contract until Phase 20/21 provisioning.
Live retention used the never-verified orphan path. Tests additionally cover verified/history
retention, corrupt/missing authority, young late writers, clock rollback, changed ETags, and
versioned/suspended-bucket refusal; those are not separate live corruption/contended-delete
claims. Tombstone/capacity reclamation and archive cleanup are intentionally not implemented.

Credential-free verification added 44 tests (375 consumer/660 workspace total), including
job work/time bounds, failed-oldest fairness, restart/deleted-boundary continuation, stale
resumed tick fencing, stopped/regressed clocks, atomic reminder rollback/concurrent dedup,
Temporal gaps/folds and explicit offsets, browser-safe conversion bundling, and exact-key
cleanup adapter contracts. `pnpm verify:release` passed, including zero pkg-guard findings,
isolated generated-app verification, and six package dry runs. Only the private app gained
the pinned Temporal polyfill dependency; no public implementation/version or workflow changed.
No real AWS resource was created or contacted.

## Phase 13: Durable Failure and Recovery

Observed on October 31, 2026, with the same pinned LocalStack `2026.10.0` image/digest,
ARM64 runtime, guarded local-only clients, and user-attested Hobby tier. The complete
`feasibility-paging-transactions-assets-publication-jobs-and-recovery` gate started
`2026-10-31T22:05:07.787Z` and completed `2026-10-31T22:08:56.837Z` in 229.050 seconds,
with `decision: go`.

Recovery run ID: `aee9f5a0-3659-4e5d-9cb8-aab0165842bd`.
Notification failure ID: `0af3dcd26fb4a6c0ea43df4768be543bf872afa803783e34e1a68408b8275827`.

| Check                                 | Observed Result                                                                                                                                                                                                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owned CLI                             | Real `jobs:inspect` and `jobs:replay` processes validated the ready lab/table ownership and returned redacted record/recovery metadata.                                                                                                                                      |
| Atomic recovery                       | Strong DynamoDB reads found the recovery request and its fresh transport's public outbox item; repeating the same request UUID retained exactly one cycle.                                                                                                                   |
| One notification                      | A direct shared SQS worker adapter wrote the real DynamoDB notification destination/history and resolved the recovery. Physical deletion of its exact worker marker allowed processing again without another business delivery.                                              |
| Pending publication collection        | After an injected post-object interruption, the shared collector persisted a pending failure but deferred while the matching publication claim was live. Its collector marker remained absent.                                                                               |
| Reconciliation before acknowledgement | Advancing the injected clock 90 seconds closed the expired claim and stalled the authoritative publication; only then did the real DynamoDB collector marker appear.                                                                                                         |
| Editor recovery                       | The normal editor command advanced publication generation. Matching S3 bytes recovered to one logical artifact. Deleting the exact collector marker and redelivering the old failure left the successful content version unchanged.                                          |
| Earlier gates                         | Actual stream/bus/queue/Lambda, paging, scoped transactions/rollback, attachments, publication recovery/corruption, due jobs/conditional cleanup, automatic Scheduler, receives 1/2/3 and durable DLQ collection, sentinel-safe reset, and reprovisioned spine passed again. |
| Cleanup                               | Owned reset preserved the independently owned sentinel/nonce, with zero owned Lambda containers afterward. Final `local:down` removed the emulator/network; filtered Docker inventories were empty.                                                                          |

The consumer SQS batches used direct shared-adapter calls with allowlisted local origin ARNs;
the consumer queues/mappings were not deployed, nor did a consumer failure actually redrive
to its own queue in this scenario. The separate spine still exercised real SQS redrive and
DLQ collection, not a substitute direct invocation. Marker deletion models physical TTL
cleanup, not a seven-day wall-clock wait; lease expiry used logical clock advancement.
CLI child output was captured privately and only safe booleans/IDs entered the evidence.
No real AWS resource was created or contacted.

Credential-free verification added 22 tests (397 consumer/682 workspace total), covering
pending-record/domain-commit interruptions, duplicate collection, replay response loss,
atomic transaction rollback, three-cycle limits, unchanged recovery history after marker
age, exact durable replay authorization, stale publication generation/success, failed durable
writes, acknowledgement/marker gaps, whole-batch partial progress and retained poison traffic.
`pnpm verify:release` passed, including zero pkg-guard findings, isolated generated-app
verification, and six package dry runs. The four-archive build contract now has a localized
30-second compilation timeout; an earlier five-second deadline failed under concurrent live
lab load, not because a runtime delivery timed out. No dependencies, public implementations/
versions, or workflows changed.

## Current Coverage and Exclusions

Phases 11-13 add publication, due/maintenance, and durable failure/replay execution with the
live evidence above. Shared consumer protocols and the separate transport spine have passed,
but consumer SQS/Lambda/Scheduler deployment is not claimed by combining independent checks.

| Capability                                      | Status                                                                                                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S3 conditional artifact storage                 | Passed in Phase 1.                                                                                                                                                                        |
| Automatic Scheduler target                      | Passed in Phase 1; AWS-equivalent failed-delivery retries are not verified.                                                                                                               |
| Actual SQS failure redrive/DLQ collector        | Passed in Phase 1.                                                                                                                                                                        |
| Live unrelated-service-resource sentinel        | Passed in Phase 1 across service-resource reset.                                                                                                                                          |
| Paged DynamoDB projection/activity queries      | Passed in Phase 3, including live memory parity, service continuation, and transactional projection moves.                                                                                |
| Scoped consumer transactions                    | Passed in Phase 7: concurrent original-response replay, logical expiry, conditional rollback, and exact-key projection moves across memory/live DynamoDB.                                 |
| Attachment lifecycle/object storage             | Passed in Phase 8: real immutable S3 readback, interrupted completion recovery, frozen review references, removal retention, and logical expiry with no object write.                     |
| Materializers/notification sink/memory pump     | Phase 9 contracts plus Phases 11/12 publication/reminder memory flows passed; consumer handlers were not deployed to LocalStack queues/Lambdas.                                           |
| Publication execution                           | Phase 11 live DynamoDB/S3 crash/lease recovery, one logical artifact, completed duplicate, and corrupt-object rejection passed. Bundled SQS marker ordering is unit-tested, not deployed. |
| Due/reminder/expiry/orphan jobs                 | Phase 12 direct live DynamoDB/S3 checkpoint/lease, daily reminder, expiry and conditional deletion passed; consumer Scheduler targets remain undeployed.                                  |
| Durable failure/recovery                        | Phase 13 owned CLI, transactional replay outbox, direct shared SQS marker/reconciliation checks, and one logical notification/artifact passed; consumer DLQ mappings remain undeployed.   |
| Full deployed/browser editorial workflow        | Not implemented; later phases.                                                                                                                                                            |
| API Gateway/CloudFormation/CDK asset deployment | Excluded from this Hobby lab; SDK provisioning is not deployment-parity evidence.                                                                                                         |
| IAM enforcement, production auth, real AWS      | Not verified; no real-AWS deployment performed.                                                                                                                                           |

The overall feasibility decision is **go**. The documented
[Scheduler emulation limitations](https://docs.localstack.cloud/aws/services/scheduler/#current-limitations),
including failed-delivery retry behavior, remain exclusions. The editorial application,
production security, real-AWS deployment, and broader operational recovery still require
their own implementation and verification; passing this gate does not establish those outcomes.
