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

## Current Coverage and Exclusions

| Capability                                      | Status                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| S3 conditional artifact storage                 | Passed in Phase 1.                                                                                         |
| Automatic Scheduler target                      | Passed in Phase 1; AWS-equivalent failed-delivery retries are not verified.                                |
| Actual SQS failure redrive/DLQ collector        | Passed in Phase 1.                                                                                         |
| Live unrelated-service-resource sentinel        | Passed in Phase 1 across service-resource reset.                                                           |
| Paged DynamoDB projection/activity queries      | Passed in Phase 3, including live memory parity, service continuation, and transactional projection moves. |
| Full editorial workflow and recovery            | Not implemented; later phases.                                                                             |
| API Gateway/CloudFormation/CDK asset deployment | Excluded from this Hobby lab; SDK provisioning is not deployment-parity evidence.                          |
| IAM enforcement, production auth, real AWS      | Not verified; no real-AWS deployment performed.                                                            |

The overall feasibility decision is **go**. The documented
[Scheduler emulation limitations](https://docs.localstack.cloud/aws/services/scheduler/#current-limitations),
including failed-delivery retry behavior, remain exclusions. The editorial application,
production security, real-AWS deployment, and broader operational recovery still require
their own implementation and verification; passing this gate does not establish those outcomes.
