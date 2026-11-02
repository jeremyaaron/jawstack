# Private Local Lab

`@jawstack/local-lab` is repository tooling, not a published package or a deployment API.
No public JawStack package depends on it. Root build/typecheck/lint/test gates include it;
ordinary unit tests require no Docker, token, service listener or real AWS access.
Root tests run one package at a time while retaining each package's file-level workers,
avoiding multiple full Vitest pools competing on busy developer machines and CI runners.

## Surface

- Bounded, own-data profiles and versioned manifests; immutable profile/archive identity.
- Explicit Hobby/token startup using the existing pinned image/digest and fixed local port.
- Readiness and exact owner/image/profile/port/network preflight.
- Running/exited/already-removing Lambda runtime reconciliation and exact-ID teardown.
- Shared tag/mapping preflight, bounded missing-resource/polling/deletion helpers.
- Public `@jawstack/aws-runtime/local` transport policy, not another SDK destination guard.
- Finite DynamoDB/stream, EventBridge, SQS, Lambda/roles/logs and S3/Scheduler providers.
- Ownership/configuration/archive audits, ordered reset and verified routing publication.

Content Operations uses these providers through its data profile and thin launcher. There
is no generic cloud DSL, arbitrary shell/SDK callback in a profile, automatic deployment,
asset-upload service or production credential provider.
The SDK callbacks in the internal mapping-deletion helper are provider/test dependencies,
not profile configuration or an authorization boundary.

## Register and Start

Imported profile modules must be pure. Build ZIPs explicitly, then capture identity at the
operation boundary. A profile's finite inventory contains project-prefixed tables, buses,
queues, roles, buckets, schedule groups and function handler/archive declarations. Optional
`services` supplies the exact finite configurations, grants, rules, mappings and schedules.
Inventory and references must agree; unknown fields, unsafe grants/environment settings,
unsupported bounds and invalid role/queue references fail before provisioning/startup.
Profile changes require owned down/recreation, not silent live reconfiguration.

```ts
import { archiveIdentity, openLab, parseProfile } from "@jawstack/local-lab";

const profile = parseProfile({
  schemaVersion: 1,
  instanceId: "demo",
  project: "jawstack-example-demo",
  functions: [
    {
      name: "jawstack-example-demo-worker",
      handler: "index.handler",
      archive: await archiveIdentity("/absolute/path/to/prebuilt.zip"),
    },
  ],
  resources: { tables: [], buses: [], queues: [], roles: [], buckets: [], scheduleGroups: [] },
});
const session = await openLab({
  operation: "up",
  statePath: "/absolute/path/to/ignored-state/demo.json",
  expected: { instanceId: profile.instanceId, project: profile.project },
  profile,
});
try {
  await session.up({ tokenFile: "/explicit/path/to/ignored.env" });
} finally {
  await session.close();
}
```

Only `up` loads the explicitly selected dotenv file; there is no app/home-directory search.
Default keys are `LOCALSTACK_AUTH_TOKEN` and `JAWSTACK_LOCALSTACK_PLAN=hobby`. An existing
launcher's key names can be selected explicitly with `planKey`/`labIdKey`. Startup environment
values take precedence. The plan is user attestation, not an entitlement audit; do not
activate trials or paid services. The token is passed only to the startup Docker subprocess,
not to SDK clients, manifests, archives or output. Docker inevitably retains the emulator's
startup environment; never inspect/dump it. Generated Compose documents contain a token
placeholder, have private permissions and are removed after the operation.

Host SDK clients consume `createLabTransport()`: dummy credentials, fixed local origin,
finite retries/timeouts, inherited-AWS-setting refusal and final HTTP destination checks
come from the public local runtime. Imports do not create clients, read tokens or do I/O.
The Docker socket is privileged. Use only the trusted pinned image on a development host
or isolated runner; this is not a sandbox for untrusted code. Never mount credential folders.
Only one lab can bind `127.0.0.1:4566`; never run over another application's listener.

## Inspect and Down

Open `operation: "inspect"` with the same profile to verify unchanged archives and call
`ready()` before application proof work. `save()` persists only a
valid manifest whose owner/profile identity still matches the session. A per-state-file
exclusive lock prevents cooperating launchers from mutating the same lab concurrently.
Always `close()` the session. A crashed process can leave a lock; investigate the exact
operation before manually removing that lock. There is no automatic stale-lock adoption.

Down does not need a profile module, archive, token or token file:

```ts
const cleanup = await openLab({
  operation: "down",
  statePath: "/absolute/path/to/ignored-state/demo.json",
  expected: { instanceId: "demo", project: "jawstack-example-demo" },
});
try {
  await cleanup.down();
} finally {
  await cleanup.close();
}
```

The saved profile supplies exact function identities. Destruction also requires the current
on-disk manifest and current container/network ownership proof; names/prefixes alone never
authorize deletion. Preflight checks all candidates before stopping the creator, reconciles
children again, removes only exact owned IDs and confirms absence. Foreign runtimes,
unexpected project services, nonlocal published ports, foreign network members and unsafe
transitions refuse cleanup. Ownership/cleanup failures retain the manifest. No pruning,
image deletion, whole-host cleanup or assumed adoption occurs.
Down discards all state inside that dedicated ephemeral emulator; it is not a service-level
reset. Service reset must separately preflight ownership and preserve unrelated sentinels.

Legacy version-1 manifests require an explicit exact `legacy` runtime profile supplied by
the existing launcher. They support **down only**, never save/upgrade/provision/reset.
Content's adapter supplies its known function inventory and old Compose network identity;
the shared package imports no app. Unknown/unprovable legacy inventories remain refused.
An old untagged network requires an owned attached-container proof in this session. An
empty legacy network is not adopted just because its Compose labels match.
New acceptance uses version-2 manifests with profile hashes and timestamped Hobby attestation.

## Provision and Reset

For a profile with `services`, open an `inspect` session using the same profile and call
`session.provision()` or `session.reset()`, then always `close()` it. These operations create
and dispose their own guarded host SDK clients; neither reads a token file or needs a token.
See [the finite schema](src/services-schema.ts),
[Content's actual data registration](../../apps/content-operations/src/lab/application-topology.ts)
and [asset capture](../../apps/content-operations/scripts/lab-profile.ts).

Provisioning requires `starting`, immutable verified ZIPs and a fully vacant inventory. A
named collision is not adopted even if its owner tag happens to match. The order is private
bucket/table/stream, bus/queues, roles/logs/functions, rules/mappings and finally schedules.
Taggable resources receive owner/lab/profile tags; mappings and schedules are proven through
their owned endpoints/groups and exact declared targets. Optional `workflowHash` adds the
workflow ownership tag needed by the public local workflow runtime; callers obtain it from
their shared owned definition. Workflow-enabled service tags use the lab ID, matching the
public runtime contract; the transitional Content profile without a workflow hash retains
its project-valued service tag. Docker ownership labels always use the project.
Named `ownerEnvironmentKey` and `profileEnvironmentKey`
inject late-bound identity, not secrets or a credential provider.

Before readiness, providers verify physical identity, tags, function archive hashes,
environment, concurrency, tables, queues, rules/targets, policies, mappings, retention and
schedule targets. Readiness is not IAM enforcement or production tuning. Source visibility
must cover six function timeouts; supported memory/concurrency stay 256 MiB/two. Schedules
use the existing rate-one-minute profile. No new provider is needed to register another
supported consumer; its functions/assets, subscriptions and explicit grants are data.

Only verified success emits `<manifest-path>.routing.json` with `schemaVersion: 1` and
`kind: "lab-services"`. It contains physical resource identities, not asset paths, secrets,
SDK options or callbacks. This lifecycle inventory is **not** the public local runtime's
`LocalWorkflowBindings` document; runtime binding/consumer migrations remain separate.
Repeat provisioning refuses without discarding valid routing. Reset invalidates owned
routing only after complete preflight, checkpoints `resetting`, removes schedules/mappings
before functions and source queues before DLQs, reconciles warm runtimes, then verifies
absence before saving `starting`. Unrelated resources are not discovered for deletion.

Every listing has finite page/item budgets and repeated/missing-cursor checks. Bucket object
keys are gathered before the first deletion; versioned buckets are refused. Partial reset
can resume, but remaining resources must still have matching ownership/configuration.
An untagged create/tag crash window stays refused rather than being adopted; retain the
manifest and investigate or use ownership-proven whole-emulator down. Errors retain state
and never publish new routing. A wrong-owner routing file is not overwritten or removed.
SDK failures carry only client/command diagnostic identity; raw responses are not logged.

Earlier lifecycle-only schema-2 profiles remain usable for owned down, not in-place service
plan adoption. Changed profiles/archives require down/recreation. Legacy Content runtime
adapters/protocols remain app-owned until their scheduled migrations; the tooling imports
none of them. The app still owns its proof scenarios, schedule test inputs and sentinels.

## Live Lifecycle Check

```sh
pnpm --filter @jawstack/local-lab verify:lifecycle \
  --token-file /explicit/path/to/ignored.env --plan-key JAWSTACK_LOCALSTACK_PLAN
```

This explicit check requires a free port 4566, Docker, the pinned image, and Hobby startup
settings. It creates a unique temporary profile/emulator and a tiny real Lambda, checks warm
runtime cleanup, foreign-lookalike refusal, orphan restart refusal and unrelated-sentinel
survival, then tears down exactly its own resources. Output is sanitized. It is not workflow
delivery/retry/recovery, Content provisioning/reset, real-AWS deployment or IAM evidence.
Never run it against the interactive review lab; no test token is printed or persisted.
