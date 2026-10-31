# LocalStack Feasibility Evidence

## Phase 0: Event Spine

Observed on October 31, 2026. The Phase 0 event spine, reset, and restart proof passed.
This is not a passing result for the entire two-phase feasibility gate; Phase 1 has not run.

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

The app's unit suite currently contains 31 tests. It checks explicit runtime/identifier
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

## Remaining Gate and Exclusions

| Capability                                      | Status                                                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| S3 conditional artifact storage                 | Not run; Phase 1.                                                                                               |
| Automatic Scheduler target                      | Not run; Phase 1.                                                                                               |
| Actual SQS failure redrive/DLQ collector        | Not run; Phase 1. The Phase 0 queue intentionally has no DLQ.                                                   |
| Live unrelated-service-resource sentinel        | Not run; Phase 1. Phase 0 tested refusal with unit doubles and scoped teardown, not the full sentinel scenario. |
| Full editorial workflow and recovery            | Not implemented; later phases.                                                                                  |
| API Gateway/CloudFormation/CDK asset deployment | Excluded from this Hobby lab; SDK provisioning is not deployment-parity evidence.                               |
| IAM enforcement, production auth, real AWS      | Not verified; no real-AWS deployment performed.                                                                 |

Phase 0 is a useful passing partial result. The overall feasibility decision remains
pending until Phase 1 records its required checks on the same pinned configuration or
explicitly documents a reviewed change.
