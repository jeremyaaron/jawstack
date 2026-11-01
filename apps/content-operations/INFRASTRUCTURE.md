# Content Operations Infrastructure

This is **synthesis-only**, not an application deployment command. The fixture auth mode
remains `dev`/`fixtures`. No real AWS execution, production authentication, API Gateway
deployment, IAM enforcement, or CloudFormation/asset delivery has been verified.

## Synthesize

From the repository root, with the repository Node/pnpm versions:

```sh
pnpm build
pnpm --filter content-operations run synth:local
```

The explicit command builds five ESM Node 22 Lambda ZIPs under `dist/infra/` and writes
the `ContentOperationsLocal` assembly under `cdk.out/`. Both paths are Git-ignored.
Archive timestamps are fixed and repeated builds retain the same asset hashes. No Docker,
token, AWS credentials, network lookup, SDK provision, or cloud request is needed.
The stack uses the dummy account `000000000000` and `us-east-1`. Optional `--lab <id>`
selects the shared lab profile. `--stage local --runtime localstack` are the only accepted
stage/runtime values; other stages, accounts, endpoint modes, and unknown arguments fail.
There is deliberately no consumer deploy script or CDK context-provider lookup.

`src/infra/config.ts` builds resources/schedules and the cost profile without reading ambient
configuration or creating clients. `src/infra/stack.ts` consumes the public
`JawStackResourceWorkflowApp` and named worker/scheduler bindings, never construct-tree
children, array positions, or private package imports. Unit tests use actual generated ZIPs
and inspect the synthesized CloudFormation template rather than deploying it.

## Composition

- One on-demand DynamoDB table with stream, TTL, and GSI; a custom EventBridge bus.
- JSON HTTP API ingress, outbox dispatcher, and the baseline five-minute outbox sweeper.
- Four source-filtered application event rules, source queues, workers, and worker DLQs.
- A durable application collector on each worker DLQ, with no collector-DLQ chain.
- Four named Scheduler functions/targets with explicit table write grants and service DLQs.
- A shared retained asynchronous-job failure destination, with no content-fact replay route.
- Private, unversioned, bucket-owner-enforced, encrypted S3 storage with public access
  blocked and a TLS policy. Nonempty buckets are not silently emptied by a custom resource.

Worker and collector batches are one, concurrency two, timeout 30 seconds, memory 256 MiB,
visibility 180 seconds, source retention four days, DLQ retention fourteen days, and logs
seven days, from the same `src/aws/profile.ts` used by the SDK lab. Scheduler targets use
`rate(1 minute)`, retry count zero, and maximum event age 60 seconds. The baseline sweeper
retains concurrency one. The base construct's old defaults and logical IDs are unchanged
when its new optional worker transport settings are omitted.

Only the publisher can read assets and read/write publication objects. Ingress can
read/write assets and read publications; it cannot delete objects. Only orphan cleanup can
inspect/delete asset objects and inspect bucket versioning. Materializers, notifications,
collectors, outbox functions, and other due jobs have no S3 grants. All due jobs receive
explicit table read/write access through `schedulerFunctionsByName`; collectors use their
matching `workerBindingsByName` DLQ. Synthesis proves policy placement, not enforcement.

## Runtime Boundary

The ZIPs contain real shared command/query, materializer, notification, publisher, failure,
job and outbox handlers, not success-shaped placeholders. Imports construct no runtime,
open no server, and resolve no credentials. The synthesized JSON wrapper and the loopback
server share `src/application/json-router.ts`, including the public-command allowlist,
scoped dispatch, typed bounded queries, replay metadata, conflict details, and redaction.

The JSON wrapper accepts only bounded API Gateway v2 JSON GET/POST requests. It does not
expose binary uploads/downloads, seed/reset, arbitrary dispatch, or a substitute worker
pump. Its health response says `synthesis-only`, not that deployed services are healthy.
Use the existing [loopback API](API.md) and [workbench](WORKBENCH.md) for complete workflows.

Every synthesized entrypoint rejects execution before client creation unless stage/runtime,
dev-fixture mode, exact function/consumer/job/queue names, fixed local table/bus/bucket,
region, and matching private LocalStack metadata are present. Real Lambda execution lacks
that emulator context and is rejected. SDK clients always use explicit dummy credentials
and the guarded `localstack:4566` destination; injected endpoint metadata is not used as a
destination. A successful synth does not authorize deployment of a fixture-auth service.

## Lab Comparison

| Boundary          | SDK LocalStack Lab                                       | CDK Synthesis                                                                               |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Ingress           | Loopback HTTP, full uploads/downloads and seed           | HTTP API plus JSON-only wrapper; no local HTTP API emulation                                |
| Provisioning      | Owned SDK calls and direct ZIP uploads                   | CloudFormation/asset references only; not deployed                                          |
| Core app delivery | Four consumers, matching rules/queues/DLQs/collectors    | Same subscriptions, source filter, batch/retention/concurrency bounds                       |
| Names             | Manifest-owned per-instance physical names               | Base construct's existing local names; comparison is by declared purpose, not identical IDs |
| Outbox            | Stream dispatcher, `TRIM_HORIZON`                        | Baseline `LATEST` stream dispatcher plus scheduled sweeper                                  |
| Due jobs          | One function handling four schedules in an owned group   | Four named functions and schedules in the default group                                     |
| Service failures  | One shared Scheduler/async-job failure queue             | Four baseline Scheduler delivery DLQs plus one shared async-job destination                 |
| Architecture      | Manifest-selected ARM64/x86_64                           | Base construct's ARM64 default, matching the observed ARM64 lab run only                    |
| TTL and S3        | Logical expiry and guarded local S3; SDK-owned cleanup   | Explicit table TTL, S3 encryption/TLS policy, no automatic bucket emptier                   |
| Verification      | Actual stream/bus/queue/Lambda/S3/Scheduler observations | Template, imports, guarded SDK contracts, and policy assertions; no deployment/IAM proof    |

The CDK template has fifteen functions, thirteen queues, four Scheduler targets, and
fifteen log groups. The SDK lab has thirteen functions and eleven queues because it
includes four feasibility functions but shares its due-job target and service-failure
queue. The feasibility proof is not part of the CDK application. The complete deployed
fault matrix runs through the SDK lab, not this template; see the
[acceptance outcome](../../docs/iterations/002-content-operations/outcome.md) and
[observed evidence](../../docs/iterations/002-content-operations/localstack-evidence.md).
