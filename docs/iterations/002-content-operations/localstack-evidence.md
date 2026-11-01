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

## Phase 14: Loopback HTTP Ingress

Observed on October 31, 2026, using the same pinned LocalStack `2026.10.0` image/digest,
ARM64 runtime, guarded endpoints/dummy credentials, and user-attested Hobby tier. The full
extended gate ran from `2026-10-31T22:40:43.406Z` to `2026-10-31T22:44:11.143Z` in
207.737 seconds with `decision: go`.

HTTP content ID: `0646f0c0-3ece-4dc9-949e-3305422843d2`.

- Actual router startup verified the ready lab manifest, owned DynamoDB table/private S3
  bucket tags, four public-access blocks, and disabled bucket versioning.
- HTTP create/registration/upload used real DynamoDB commands and S3 bytes. Strong HTTP
  resource version matched DynamoDB authority, and the bounded status/title query found
  the real projection. A second fixture downloaded the exact verified PNG through the API.
- Pending slots were not downloadable. Stale edits returned 409; another author's edit and
  internal completion commands returned 403. Uncommitted publication returned 404.
  JSON/upload results excluded storage configuration, object keys, and fencing tokens.
- Health explicitly reported `localstack` / `external-workers`. No host pump or direct
  consumer invocation was substituted for deployed queue/Lambda/Scheduler transport.
- All prior spine, service paging, scoped transactions, assets, publication recovery, jobs,
  recovery/CLI, automatic Scheduler, actual SQS redrive/collector, sentinel-safe reset, and
  reprovisioned-spine checks passed again. The unrelated sentinel/nonce survived reset and
  zero owned Lambda containers remained afterward. Final `local:down` removed the owned lab.

The HTTP-only memory walkthrough additionally executes create/upload/review/approve/
schedule/publish/download/preview/operations/activity/archive through the managed API.
Credential-free suites now contain 413 consumer / 698 workspace tests, including fixed
fixture authorization, public command exclusion, scoped query budgets/continuations,
empty filtered pages, stable overdue cutoffs, strict calendar/filter inputs, transport/body
limits, private authority rereads, seed idempotency, import/config side effects, stalled
bodies, and managed shutdown. `pnpm verify:release` passed: format/typecheck/test/lint/build,
zero pkg-guard findings, isolated generated-app checks, and six package dry runs.

No real AWS resource, dependency, public framework/template implementation, version, or
workflow changed. Consumer worker/Scheduler deployment and Angular screens remain later work;
the memory result is not evidence of deployed consumer transport or production auth.

## Coverage Through Phase 14

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
| Loopback HTTP commands/queries/private storage  | Phase 14 actual router/DynamoDB/private S3 ingress passed; managed memory HTTP workflow passed, without claiming deployed consumer workers.                                               |
| Full deployed/browser editorial workflow        | Not implemented; later phases.                                                                                                                                                            |
| API Gateway/CloudFormation/CDK asset deployment | Excluded from this Hobby lab; SDK provisioning is not deployment-parity evidence.                                                                                                         |
| IAM enforcement, production auth, real AWS      | Not verified; no real-AWS deployment performed.                                                                                                                                           |

The overall feasibility decision is **go**. The documented
[Scheduler emulation limitations](https://docs.localstack.cloud/aws/services/scheduler/#current-limitations),
including failed-delivery retry behavior, remain exclusions. The editorial application,
production security, real-AWS deployment, and broader operational recovery still require
their own implementation and verification; passing this gate does not establish those outcomes.

## Phase 20: Deployed Application Runtime

The application now has a separate live happy-path gate rather than inferring deployment
from the historical adapter checks above. It retains the feasibility transport/redrive
regression and uses the same pinned image, ARM64 host/runtime, Node 22 ESM bundles, and
user-attested Hobby entitlement. Only guarded local endpoints and dummy SDK credentials
were used; the token was passed only to the emulator. No real-AWS deployment was performed.

The topology consists of thirteen functions (four feasibility, four application workers,
four application collectors, one jobs target), one table/stream/bus/private unversioned
bucket, five rules/schedules, eleven queues including DLQs and a retained service-failure
destination, twelve execution roles, and seven-day logs. Application queues use 180-second
visibility, three receives, batch one, four-day source/fourteen-day DLQ retention; functions
use 30-second timeout, 256 MiB and concurrency two. The proof retains its shorter bounds.

The first complete deployed gate passed from `2026-11-01T03:31:18.880Z` through
`2026-11-01T03:36:28.868Z` in 309,988 ms. It checked:

- Actual loopback HTTP commands and guarded DynamoDB authority; no host consumer/job pump.
- Real PNG upload/download and actual asset/review materializer Lambda outcomes.
- Submitted/approved frozen content scheduled five seconds ahead, then an automatic
  `rate(1 minute)` due job through stream -> bus -> SQS -> publisher Lambda.
- Exact immutable publication bytes/digest, one logical artifact, three unique business
  notifications, one succeeded attempt, published outbox and worker completion markers.
- HTTP projection queries, stale/ownership/internal-command denials, private metadata
  redaction, and rejection of pending/uncommitted downloads/previews.
- The feasibility command transaction, replay, automatic tick, S3 output, actual source
  receives 1/2/3, durable proof DLQ collector acknowledgement, and an empty proof DLQ.
- Ownership-safe reset with unrelated sentinel nonce unchanged, all owned service resources
  absent, zero warm Lambda containers after reset, reprovision, and another actual app flow.

An initial live attempt was interrupted after the new context guard rejected LocalStack's
injected bridge endpoint metadata. The fix accepts only the matching private emulator metadata
without using it as a client destination; final transport allowlisting is unchanged. A
concurrent ZIP-reader unit failure also exposed non-atomic archive replacement; builds now
publish archives with atomic rename. Neither issue was suppressed or counted as a pass.

The final cold-start repeat also passed from `2026-11-01T03:38:21.298Z` through
`2026-11-01T03:44:18.167Z` in 356,869 ms, after a full owned Compose teardown/restart and
reprovision with the final topology/guards. Both application runs again yielded one
artifact, three unique notifications, and one succeeded attempt. Sentinel ownership/data
and complete service-resource absence passed; zero warm Lambda containers remained after
reset, before reprovisioning the second actual app workflow.

An additional live seed check used the actual HTTP seed CLI against an ephemeral loopback
API: six deterministic examples were created, the publication example completed in the
real publisher Lambda, and a second seed skipped all six without changing any content
version. The temporary ingress closed. `local:down` passed after verification; the owned
emulator/network and all warm Lambda containers were removed, no matching containers
remained, and images were retained. Existing memory web 4336 / API 4337 stayed healthy
with the review page and development dataset preserved.

This is Phase 20 evidence, not the complete Phase 22 failure matrix. Actual application
DLQ/replay/crash/lease/obsolete-generation injection and browser-on-local acceptance are
not inferred from the separate proof DLQ or memory browser suite. Scheduler failed-delivery
retry fidelity, IAM enforcement, API Gateway/CloudFormation/CDK deployment, production auth,
and real AWS remain unverified/excluded. Older direct-call crash/injected-clock live fixtures
are retained as historical evidence, not run beside asynchronous application consumers.

## Phase 21: Synthesis and Runtime Regression

Observed November 1, 2026. The consumer now composes the public framework CDK construct,
private S3, four worker-DLQ collectors, named due-job write grants, and a synthesis-only
JSON ingress. The same infrastructure profile drives supported lab/synth comparisons;
the [infrastructure guide](../../../apps/content-operations/INFRASTRUCTURE.md) lists deliberate
differences. Synthesis and import checks use no token, Docker, credentials or cloud requests.
Default synthesized API/materializer/notification handlers also have guarded SDK contract
coverage; those simulated transactions are not deployment or IAM-enforcement evidence.

The existing SDK-provisioned application gate was rerun against the shared JSON router and
immutable-object protocol. It passed from `2026-11-01T04:34:34.428Z` to
`2026-11-01T04:40:36.197Z` in 361,769 ms on the pinned ARM64/Hobby lab. Both actual application
flows yielded one artifact, three notifications, and one succeeded attempt. Actual automatic
Scheduler execution, proof redrive/durable collection, published outbox/worker markers,
sentinel preservation, owned-resource absence, zero warm containers after reset, and
reprovision passed. This was the existing SDK topology, **not a CDK deployment**.

Final shutdown exposed a lifecycle edge: the emulator stopped but two warm jobs/materializer
containers and seven exited runtime containers survived beyond the cleanup deadline. Their
exact IDs, creation times within this run, lab ID, and declared function identities were
checked without dumping environments or credentials; application contexts also matched
their local stage/runtime. Recovery stopped the two running containers and removed only
those nine confirmed exited containers. Repeating `local:down` then passed, with no owned
emulator or Lambda containers remaining and images retained. Automatic ownership-proven
orphan-runtime recovery is added to Phase 22's teardown coverage; no broad prefix deletion
was introduced. The original down timeout is not counted as an automatic teardown pass.

## Phase 22: Full Failure, Isolation and Cleanup Gate

Observed November 1, 2026, on the same pinned `2026.10.0` emulator digest,
macOS/Docker ARM64 host, Node 22 ESM Lambda configuration, and user-attested Hobby
entitlement above. Clients used explicit dummy credentials and guarded local endpoints;
the token was supplied only to the emulator. No trial activation, real AWS requests,
or CDK/CloudFormation deployment was performed.

The full gate passed from `2026-11-01T05:40:06.877Z` to
`2026-11-01T05:57:32.593Z`, in **1,045,716 ms** (17 minutes 26 seconds). Decision:
**go for this local integration gate**, not production readiness or AWS parity.
The final sanitized machine result remains in the Git-ignored
`apps/content-operations/.localstack/dev-evidence.json`. It was marked passed only
after reset, reprovision, repeated workflow, and final Docker teardown succeeded.

### Observed Results

| Check                      | Observed Result                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation                  | 24 unsafe endpoint/inherited-credential/runtime probes rejected; zero calls reached the AWS SDK network transport.                                                                                                                                                                                                                                                                          |
| Both happy paths           | Actual HTTP draft/upload/review, automatic scheduled publication, real materializers, one exact immutable artifact, three unique notifications and one succeeded attempt, before and after reset.                                                                                                                                                                                           |
| Transient publisher        | Injected failure before execution left no completion marker; normal SQS redelivery completed publication.                                                                                                                                                                                                                                                                                   |
| Object-write interruption  | Private object existed while preview remained 404. A live-lease duplicate did not mutate authority or complete its marker. Automatic redelivery after lease expiry produced one expired and one succeeded attempt, unchanged bytes/digest, and one logical object.                                                                                                                          |
| Terminal publisher         | Actual source Lambda receives 1, 2 and 3, followed by real DLQ redrive.                                                                                                                                                                                                                                                                                                                     |
| Interrupted collector      | Failure record was durable with pending resolution, no completion marker, and source still retained in the DLQ. Automatic collector retry reconciled publication to stalled; marker and actual queue acknowledgement/drain followed.                                                                                                                                                        |
| Editor recovery            | Actual HTTP retry and equivalent idempotent replay returned the original success structurally; publication succeeded in generation two.                                                                                                                                                                                                                                                     |
| Notification recovery      | Terminal notification was durably collected; actual owned CLI replay and repeated request produced one recovery cycle, one resolved generation and one business delivery through outbox/stream/bus/queue/Lambda.                                                                                                                                                                            |
| Permanent business guards  | Selected markers were deleted before diagnostics. Completed publication duplicates, older review facts, obsolete generations and a late collector did not change completed authority or stable artifact bytes; published notification remained unique.                                                                                                                                      |
| Operational queries/errors | Real HTTP paged attempts/notifications/failures, invalid cursor rejection, missing-table failure without backend detail leakage, and explicit missing-bucket storage failure passed.                                                                                                                                                                                                        |
| Feasibility regression     | Transaction/replay/outbox/receipt/S3 checks, concurrent conditional object creation, automatic rate tick, source receives 1/2/3, durable proof collector and empty proof DLQ passed.                                                                                                                                                                                                        |
| Reset/reprovision          | Separate-owner sentinel nonce preserved; owned service resources absent and zero Lambda runtimes after reset. Reprovision and another complete application workflow passed.                                                                                                                                                                                                                 |
| Final teardown             | Separate-owner Docker lookalike refused before emulator/owned runtime stop. A cached-runtime-image shell fixture was observed exited, another running; final down stopped/removed the running orphan and removed the exited fixture. Result: one running child reconciled, two children removed, zero matching emulator/runtime containers and networks, images retained, manifest removed. |

### Method and Corrections

The gate builds a separate verification-only archive and temporarily updates the eight
owned application workers/collectors. Function ownership, owner environment, handlers and
standard archive hashes are checked before any update. Wrappers inject owner/run-scoped,
conditionally consumed faults into the shared production execution factories; actual
Lambda invocations record receipt identity and source receive counts in the owned table.
All changed standard archives were restored and their hashes checked before reset.
Standard lab/synthesis bundles do not contain the fault-control reader.

Application queue visibility remained **180 seconds** with three receives and normal
publication leases. There were **zero clock advances and zero host worker invocations**.
Exact committed-fact republishes through EventBridge and a late original copy through
the owned DLQ are intentional diagnostics, not automatic Scheduler sources. Marker
deletion tests business guards independently of the transport cache. Cleanup shell
fixtures test real Docker lifecycle behavior using the cached runtime image; they are
not presented as application Lambda invocations.

An initial complete attempt remained failed/no-go at `05:38:07.281Z` because the new
verifier compared serialized HTTP reply key order. An actual HTTP/DynamoDB replay then
confirmed structurally equal replies with different serialization order. The assertion
was corrected to the existing structural-equality pattern, and the entire gate was
rerun successfully. The failed run's automatic down also reconciled one observed running
owned Lambda remainder and verified zero matching containers/network. Interrupted
exploratory runs were cleaned through the owned lifecycle; none count as acceptance passes.

The final Docker inventory independently confirmed no matching containers or named lab
network. Existing memory web 4336 / API 4337 remained healthy and their dataset was not
reset. Verification now performs final down itself; interactive use requires fresh up/
provision afterward. Reproduction follows the [application README](../../../apps/content-operations/README.md).

This proves the SDK-provisioned local path, including actual application failure/recovery
transport. It does **not** verify IAM enforcement, production authentication, real email,
API Gateway/CloudFormation deployment, real AWS behavior/costs, or Scheduler failed-delivery
retry parity. Browser-on-local acceptance and CI configuration remain Phase 23; no browser
run is inferred from this gate. Public packages/dependencies/versions and CI triggers
were unchanged in Phase 22.

## Phase 23: Browser Acceptance and CI Boundaries

Observed November 1, 2026, with Playwright 1.64.1/Chromium on the same ARM64 host,
pinned emulator digest and user-attested Hobby entitlement. Local browser acceptance
used a separate disposable `e2e23` lab, not the interactive memory dataset.

### Browser Results

- The complete credential-free memory suite passed **30 cases**, zero skips/unexpected/
  flaky results, from `2026-11-01T13:52:16.398Z` in 367,290 ms (rounded to milliseconds).
  Cases cover all five views, distinct author/editor fixtures, normal and failure flows,
  keyboard/validation/route focus, preserved queries/return links, stale/ambiguous commands,
  actual image/PDF transfers, immutable preview/JSON, scheduling and paged operations.
- Desktop 1440x900 and mobile 390x844 screenshots were inspected across workbench, editor,
  review, calendar and operations, plus actual rendered bitmap/publication states. Shared
  assertions reject uncaught page errors, horizontal control/heading overflow and header/
  content overlap. Existing editor section-spacing assertions remain active.
- The final LocalStack browser repeat passed **both cases**, zero skips/unexpected/flaky
  results, from `2026-11-01T14:40:52.730Z` in 202,573 ms. Browser commands created/uploaded/
  submitted content, switched author/editor fixtures, approved a frozen review, scheduled
  publication, navigated calendar/return state, rendered the real immutable image/artifact,
  downloaded redacted JSON, paged three notifications and observed one succeeded attempt.
  Read-only API checks verified actual secondary asset/review materialization and published
  authority. Health required `localstack` / `external-workers`; no host pump, injected clock,
  direct consumer invocation or intercepted success response drove this path.
- Both failed and successful browser runs released their owned API/web ports. Memory uses
  4437/4436; LocalStack uses 4537/4536. Existing review web 4336 / API 4337 were not reused,
  stopped or reset. Results/screenshots remain under the app's ignored `test-results/`.

### Pipeline and Reset Regression

The first new browser assertions exposed test timing issues: board link names include
metadata, operation-tab contents change asynchronously, and a live submit click can return
before its HTTP command commits. Assertions now target the title heading and await the
new view/row count or committed Open Review state. No sleeps, retries, weaker outcome
assertions or larger timeout budgets were introduced to hide these failures.

The first post-browser full integration gate remained **failed/no-go** at
`2026-11-01T14:31:05.276Z`, after successful application failure and feasibility scenarios,
because reset rejected runtime inventory metadata. Automatic final down still verified
zero matching containers/network and removed the manifest. Inspection identified an
unmodeled Docker `removing` transition in the inventory parser. The fix proves labels,
declared function name and immutable ID first, then waits up to thirty seconds for that
exact ID to disappear without issuing another stop/remove. Unknown, foreign and stuck
transitions remain errors. Invalid metadata reports field names, never private values.
Focused tests cover finishing/stuck removals and foreign refusal; see
[Docker's state reference](https://docs.docker.com/reference/cli/docker/container/ls).

The complete browser -> integration sequence was rerun. After the two browser cases,
`verify:local --confirm-reset` passed from **`2026-11-01T14:44:16.307Z`** through
**`2026-11-01T15:01:28.640Z`**, in **1,032,333 ms**. All Phase 22 delivery/isolation scenarios
passed again, including three terminal receives, interrupted durable collection and actual
automatic retry/drained DLQs, crash/lease recovery, editor/CLI recovery, duplicate and
obsolete-generation protection, and standard archive restoration. Sentinel data survived
reset, all owned service resources and warm runtimes were absent, and reprovision plus a
second complete app workflow passed. Final teardown refused the foreign lookalike before
stopping the emulator, reconciled the running/exited fixtures (one running child, two
children removed), and verified zero owned containers/network. Images remain; the manifest
is gone. The sanitized result is `.localstack/e2e23-evidence.json`; only that evidence JSON
is copied into the diagnostic artifact selection, not the manifest or token file.

### CI Status and Limits

PR/manual CI now includes credential-free memory browsers and a real browser-boundary build.
A separate manual, default-branch-only workflow references the `localstack-hobby` environment;
missing token/attestation exits nonzero with **NOT-RUN** before Docker starts. Only preflight
and startup receive the token. YAML boundary tests verify triggers, read-only permissions,
non-persisted checkout, environment/branch conditions, secret scope, finite timeouts,
always-run ownership cleanup, and explicit bounded artifact uploads. Diagnostics reject
symlinks, more than 300 files/100 MiB and excessive traversal; retention is seven days.

**Actual GitHub dispatch: NOT RUN.** The workflow must be merged and its environment branch/
approval rules, secret and Hobby attestation configured separately. Passing local commands
do not claim that remote job ran or that its environment is configured. See the
[workbench instructions](../../../apps/content-operations/WORKBENCH.md#ci-and-diagnostics).
The local equivalent sequence above passed with no real AWS/CDK deployment. IAM enforcement,
production auth, real email and Scheduler failed-delivery parity remain excluded.

## Phase 24: Final Acceptance Audit

Observed November 1, 2026 on the same 8 GiB ARM64 development host with Node 24.16.0,
pnpm 10.21.0, Playwright 1.64.1/Chromium, pinned emulator digest, and user-attested Hobby
entitlement. Expensive release, memory-browser and live gates ran sequentially. Existing
interactive memory web 4336 / API 4337 and its edited review fixture were not reset.

### Clean Context and Browser Results

- A fresh clone of `45500a40db3df53cef6a555319243cb3089e350d` installed with the frozen
  lockfile and built without existing checkout outputs. `pnpm verify:release` passed:
  804 workspace tests, including 511 consumer tests, zero pkg-guard findings, isolated
  generated-app installation/typecheck/tests/build/synth/doctor, and six package dry runs.
  Consumer browser boundary was 230 modules / zero server imports.
- Initial full memory acceptance passed 30 cases. The first `final24` Hobby browser
  attempt then failed desktop native `datetime-local` filling when generated seconds were
  `00`; Chromium normalized them away and Playwright rejected the non-identical value.
  Mobile passed, but that whole run remains failed. Its log/report/traces are preserved
  separately, and ownership-checked down verified zero containers/network afterward.
- The narrow fixture correction always enters canonical minute precision at least thirty
  seconds ahead and asserts the input value. There is no changed runtime/domain policy,
  timeout increase, test retry, accelerated clock, host worker, or substituted response.
  The same patch was applied to the fresh checkout; release regression passed again.
- Corrected complete memory acceptance passed **30 cases**, zero skipped/unexpected/flaky,
  from **`2026-11-01T15:45:18.210Z`**, in **365,528 ms**. Its diagnostics were within budget:
  75 selected files / 8,102,302 bytes, including its boundary report and JSON result.
- After fresh `final24` startup/provisioning, corrected live browser acceptance passed
  **both desktop/mobile cases**, zero skipped/unexpected/flaky, from
  **`2026-11-01T15:52:22.794Z`**, in **233,431 ms**. The shared workflow checked actual
  upload bytes and decoded bitmap, secondary asset/review materialization, author/editor
  permissions, frozen approval, automatic scheduled publication, committed preview/JSON,
  one succeeded attempt and three unique notification deliveries. Final desktop/mobile
  publication screenshots were visually inspected in addition to layout/media assertions.

### Final Live Gate

`verify:local --confirm-reset` passed against that same owned lab after browser shutdown,
from **`2026-11-01T15:56:17.228Z`** through **`2026-11-01T16:13:31.838Z`**, in
**1,034,610 ms**. The sanitized `.localstack/final24-evidence.json` records `passed` / `go`.
It establishes:

- Twenty-four unsafe-configuration probes rejected with zero network requests and no
  credential loading; actual missing-table/bucket errors remained failures, not empty reads.
- Actual HTTP/upload/materialized review/asset, frozen approval, automatic due publication,
  one logical immutable artifact, three unique notifications, one succeeded attempt,
  published outbox/worker markers, and nine ownership-proven warm application runtimes.
- Normal 180-second visibility, no clock advance or host worker invocation; transient
  retry, post-object crash/lease expiry, two crash attempts, terminal receives 1/2/3,
  collector record-before-ack interruption, retained source and automatic collection retry,
  drained application DLQs, generation-two editor retry and one CLI replay cycle.
- Marker-loss duplicates, older reviews, obsolete generations and late collectors did not
  duplicate or replace completed business outcomes. Exact stored-fact EventBridge republication
  and late owned-DLQ copy remained separately identified diagnostics. Standard code hashes
  were restored before reset.
- Sentinel owner/payload survived reset, owned resources and warm runtimes were absent,
  and reprovisioned spine plus a second complete application workflow passed.
- Foreign runtime lookalike refused before emulator/owned runtime shutdown; final teardown
  stopped one owned running fixture and removed two fixtures, verified zero matching
  containers/network, retained cached images, and removed the ownership manifest.

An independent Docker inventory confirmed the named lab network and owned containers were
absent; unrelated stopped/created containers were left alone. Selected final live diagnostics
were within budget: eight files / 610,063 bytes, including only the specifically copied
sanitized evidence JSON, not the manifest/token file. Both final browser viewports were
visually inspected. The initial failed browser attempt remains recorded above, not hidden
by the successful rerun.

After teardown, the documented memory API/seed CLI was smoke-tested in the clean checkout
on isolated API 4637 / allowed web origin 4636. Health reported `memory` / `managed`;
first seed created six items, repeat seed skipped all six, and authoritative reads showed
draft, in-review, changes-requested draft, approved, scheduled, and published examples.
The owned temporary API was then stopped. It did not reuse or reset review API 4337.

The final full `pnpm verify:release` also passed after copying current product/package
Markdown into the clean-install checkout, including the actual package READMEs: 804
workspace tests (511 consumer), typecheck/lint/build/format, zero pkg-guard findings,
isolated generated-app checks and six package dry runs. Final local links/anchors and
diff checks passed. All owned browser/smoke ports were closed; the existing review app
and source HEAD were unchanged. The phase is left uncommitted for user review.

Remote GitHub dispatch/environment configuration, real AWS/CDK deployment, IAM enforcement,
production auth, provider notifications, and Scheduler failed-delivery retry parity remain
**not performed / not established**. This local pass does not authorize publication or a tag.
