# Private Local Lab

`@jawstack/local-lab` is repository tooling, not a published package or a deployment API.
No public JawStack package depends on it. Root build/typecheck/lint/test gates include it;
ordinary unit tests require no Docker, token, service listener or real AWS access.
Root tests run one package at a time while retaining each package's file-level workers,
avoiding multiple full Vitest pools competing on busy developer machines and CI runners.

## Phase 8 Surface

- Bounded, own-data profiles and versioned manifests; immutable profile/archive identity.
- Explicit Hobby/token startup using the existing pinned image/digest and fixed local port.
- Readiness and exact owner/image/profile/port/network preflight.
- Running/exited/already-removing Lambda runtime reconciliation and exact-ID teardown.
- Shared tag/mapping preflight, bounded missing-resource/polling/deletion helpers.
- Public `@jawstack/aws-runtime/local` transport policy, not another SDK destination guard.

Service providers and provision/reset still live in Content Operations until Phase 9.
There is no shared provision/reset command, generic cloud DSL, arbitrary shell/SDK callback
in a profile, automatic deployment, asset-upload service or production credential provider.
The SDK callbacks in the internal mapping-deletion helper are provider/test dependencies,
not profile configuration or an authorization boundary.

## Register and Start

Imported profile modules must be pure. Build ZIPs explicitly, then capture identity at the
operation boundary. A profile's finite inventory contains project-prefixed tables, buses,
queues, roles, buckets, schedule groups and function handler/archive declarations. Phase 8
uses this as the lifecycle identity envelope, not as a complete provisioning specification;
Phase 9 will add the finite service configurations and workflow-derived subscriptions.
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
`ready()` before app-owned provisioning/reset. The transitional `save()` persists only a
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
