# Content Operations

Private first-party JawStack consumer. Iteration 2 Phase 0 currently supplies only the
isolated LocalStack event-spine harness, not the editorial application or an Angular UI.

## Credential-Free Checks

From the repository root:

```sh
nvm use
pnpm install
pnpm build
pnpm --filter content-operations run typecheck
pnpm --filter content-operations run test
pnpm --filter content-operations run lint
pnpm --filter content-operations run build
```

These commands do not start Docker, load the token file, resolve AWS credentials, or
connect to any AWS service. The build creates a bundled Node 22 Lambda ZIP under `dist/`.
Build the workspace once so the harness can bundle installed public package entrypoints.
Unit tests are explicitly restricted to `test/unit/**/*.test.ts`; live integration is a
separate script, never a token-dependent test in default discovery.

## LocalStack Prerequisites

- A running Docker engine with Compose v2 and enough RAM for LocalStack plus two Node Lambdas.
- Port 4566 available on loopback.
- A LocalStack account on the free non-commercial Hobby plan, not a paid trial.
- A LocalStack token placed in `.env.localstack` in this directory:

```dotenv
LOCALSTACK_AUTH_TOKEN=<your token>
CONTENT_OPS_LOCALSTACK_PLAN=hobby
```

The file is Git-ignored. Do not paste the token into chat, commit it, or run commands that
dump Compose/container environments. The plan flag records user attestation, not a
programmatic license audit. Environment variables may supply the same two settings in CI.

The image is pinned to LocalStack `2026.10.0` and its multi-architecture SHA-256 digest in
`compose.yaml`. This does not use a paid asset-deployment feature or real AWS deployment.
The lab is ephemeral; recreation discards data, and images remain cached after teardown.

Docker socket access gives the emulator substantial privileges on the local Docker host.
Use the trusted pinned image on a development machine or isolated runner, not as a sandbox
for untrusted code. Do not mount real credential directories.

## Run the Spine Proof

From the repository root:

```sh
pnpm --filter content-operations run local:up
pnpm --filter content-operations run local:provision
pnpm --filter content-operations run verify:local
```

The commands create a dedicated `jawstack-content-ops-dev` Compose project/network and
app-owned local resources: DynamoDB table/stream, EventBridge bus/rule, SQS queue, IAM role,
two Lambda functions, and bounded-retention logs. Lambda ZIPs are uploaded through the SDK.

The proof executes the `spineProof.create` command with a scoped idempotency key using
public JawStack APIs. The same transaction stores state, activity, projection, outbox, and
idempotency records. Its DynamoDB stream invokes the real outbox dispatcher Lambda;
EventBridge routes the event to SQS; the actual worker Lambda writes an idempotent receipt.
Verification checks the stored records, response replay, correlation, published outbox,
and one logical receipt. It does not invoke the worker directly or publish a substitute event.

The CLI prints sanitized results and writes local proof metadata under `.localstack/`.
Ownership manifests there are required for safe lifecycle operations; do not delete them
while the lab runs. Use `CONTENT_OPS_LAB_ID` (1-16 lowercase letters/digits/hyphens) to
select another explicit instance; only one instance can bind the fixed host port at a time.

## Reset and Stop

Reset only resources owned by the current manifest, leaving the emulator running:

```sh
pnpm --filter content-operations run local:reset --confirm-reset
pnpm --filter content-operations run local:provision
pnpm --filter content-operations run verify:local
```

Stop the entire owned ephemeral lab and remove its container/network:

```sh
pnpm --filter content-operations run local:down
```

Reset preflights ownership tags on every known resource before deleting anything. It also
checks the expected event-source mappings. Provisioning refuses pre-existing named
resources rather than adopting or retagging them. On interrupted provisioning, use reset
with the intact manifest; on a failure, the manifest is retained for recovery.

## Isolation and Limits

Host SDK requests are restricted to `http://127.0.0.1:4566`; Lambda SDK requests target
`http://localstack:4566` on the dedicated network. Every client has explicit dummy
credentials, region, finite retries, and a final HTTP transport destination guard. Unexpected
queue origins/names are rejected. Host launchers reject inherited AWS credential/profile,
role, endpoint, or credential-file settings; start from a clean shell rather than relying
on a default AWS profile. No local command has a real-AWS fallback.

Readiness and service waits are bounded. A cold initial Lambda runtime image pull may take
time; if it exceeds the limit, inspect the owned local logs privately, then reset/retry.
Docker/service errors are summarized instead of dumping potentially sensitive output.

This phase does not verify S3, Scheduler, DLQ recovery, IAM enforcement, API Gateway,
CloudFormation, production auth, or real AWS behavior. Those are either Phase 1 checks or
explicit exclusions. The current queue intentionally has no DLQ until Phase 1 adds the
failure scenario. Do not use this harness for production jobs.

Planning and observed results:

- [Implementation Plan](../../docs/iterations/002-content-operations/implementation-plan.md)
- [Technical Design](../../docs/iterations/002-content-operations/technical-design.md)
- [LocalStack Evidence](../../docs/iterations/002-content-operations/localstack-evidence.md)
