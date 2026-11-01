# Content Operations

Private, maintained JawStack reference application for a small editorial team: draft,
attach files, request review, approve, schedule, publish an immutable JSON snapshot, and
inspect asynchronous outcomes. It is an application you can modify, not a generated CMS
or a new CLI template. `create-jawstack` still generates the Work Requests starter.

## Modes

| Mode          | Persistence and processing                                                         | Credentials / deployment                                      | Use                                                               |
| ------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| Memory        | Volatile state/objects; shared workers and due jobs managed by the API             | None; no Docker or AWS requests                               | Daily development, seeded walkthrough, full browser suite         |
| LocalStack    | Owned DynamoDB/private S3; real stream/bus/queue/Lambda workers and Scheduler jobs | Separately provisioned disposable Hobby lab; local token only | Asynchronous transport, retry/recovery and cleanup proof          |
| CDK synthesis | Template and guarded JSON-only entrypoints                                         | No deployment or credentials                                  | Policy/topology assertions, not a third runnable application mode |

Both runnable modes use the same loopback API and Angular workbench. Fixture identities
are development-only, not authentication. Nothing here authorizes a real-AWS deployment.
See [architecture/protocols](ARCHITECTURE.md), [HTTP contracts](API.md),
[workbench behavior](WORKBENCH.md), and [CDK boundaries](INFRASTRUCTURE.md).

## Start in Memory

From the repository root, use the Node version in `.nvmrc` and pnpm pinned in `package.json`:

```sh
nvm use
pnpm install --frozen-lockfile
pnpm build
pnpm --filter content-operations run dev:api
```

In another terminal at the repository root:

```sh
pnpm --filter content-operations run seed --runtime memory
pnpm --filter content-operations run dev:web
```

Open [the workbench](http://127.0.0.1:4326/content). Health is at
`http://127.0.0.1:4327/api/health` and should report `memory` / `managed`.
Root `pnpm dev:web` and `pnpm dev:api` still select Work Requests, not this application.
If a port is occupied, choose matching explicit overrides for both servers and seed;
see [alternate ports](WORKBENCH.md#run-locally). Never reset someone else's running session.

### Fixtures and Walkthrough

Seed uses ordinary commands and creates six `Release notes:` examples: draft, pending
review, changes requested, approved, scheduled, and published (with a real PNG). Fixed
content IDs end in `000001` through `000006`; existing IDs, including partial seeds, are
skipped rather than overwritten. Revisions, review IDs, and due instants are generated
normally. `author_1` owns these examples; `author_2` is useful for denial checks. Either
`editor_1` or `editor_2` can decide a review. All four can read the shared workspace.

1. Choose `author_1`, create a content item, edit its title/body, and save. Use your own
   item to keep the seeded examples intact. A stale save retains your text and offers an
   explicit comparison; refresh never silently overwrites an unsaved draft.
2. Add a small valid PNG/JPEG/PDF and select `Upload attachment`. Wait for `ready`;
   transfer completion alone is not verification. Inspect the private thumbnail/download.
3. Submit the saved item for review, assigned to `editor_2`. Open its review, switch to
   `editor_2`, enter a decision note, and approve the frozen snapshot. An author cannot approve.
4. Return to content and schedule it a minute or two ahead in an explicit time zone.
   Inspect the calendar's month and agenda views. Gap/fold wall times are rejected.
   Alternatively, an editor can publish an approved item immediately.
5. Leave the page visible and wait for due evaluation and publication. Memory jobs run
   once per minute; LocalStack uses automatic Scheduler delivery. The browser does not
   trigger the worker. A committed preview and redacted JSON export appear only after
   verified storage and authoritative completion.
6. As an editor, open Operations and inspect the succeeded attempt, linked notification
   deliveries, and correlation history. Normal happy-path runs need not have failures.

Reopen/cancel/reschedule, stale-version comparison, review history, and failure recovery
are described in the [workbench guide](WORKBENCH.md). Reloading/restarting memory is not
durable storage: stop the API with Ctrl-C, start it again, and seed to create a fresh dataset.

## Start the Hobby Lab

Requires Docker with Compose v2, free loopback port 4566, and a LocalStack account on
**Hobby, not a paid trial**. Put these assignments in the Git-ignored
`apps/content-operations/.env.localstack`:

```dotenv
LOCALSTACK_AUTH_TOKEN=<your token>
CONTENT_OPS_LOCALSTACK_PLAN=hobby
```

Do not commit or print the file, dump container environments, mount credential directories,
or inherit AWS profile/credential/endpoint settings. Use a clean shell. The plan flag is
user attestation, not an entitlement audit. Docker socket access is privileged; use the
trusted pinned image on a development host or isolated runner, not for untrusted code.

After the workspace build, from the repository root:

```sh
pnpm --filter content-operations run local:up
pnpm --filter content-operations run local:provision
pnpm --filter content-operations run dev:api:local
```

In another terminal, seed with `--runtime localstack` and start `dev:web` as above. Health
must report `localstack` / `external-workers`. There is no host pump or automatic mode
fallback. Materialized reviews/assets, publication, and notifications settle asynchronously.
The lab defaults to ID `dev`; set `CONTENT_OPS_LAB_ID` consistently for another owned lab.
Only one lab can bind host port 4566. The image/digest are pinned in `compose.yaml`.

### Service Matrix

| Boundary                   | Implemented local proof                                                                       | Not established                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| DynamoDB                   | Atomic state/activity/outbox/projection/idempotency writes, stream dispatch, bounded queries  | Real-AWS scaling, service quotas, production backup/restore                   |
| EventBridge / SQS / Lambda | Bundled workers, automatic retry/redrive, durable DLQ collection, replay deduplication        | Exactly-once transport or arbitrary external side effects                     |
| S3                         | Private immutable bytes, conditional writes/readback/digest, interrupted-publication recovery | Malware scanning, production retention policy, AWS IAM enforcement            |
| Scheduler                  | Real automatic due jobs and observable downstream effects                                     | AWS-equivalent failed-delivery retry behavior                                 |
| Lifecycle                  | Manifest/tag/label ownership preflight, sentinel survival, reset/reprovision, orphan teardown | Preservation of data inside a discarded dedicated emulator                    |
| CDK / ingress              | Credential-free synth and policy/topology/JSON-wrapper tests                                  | CDK deployment, CloudFormation assets, API Gateway execution, production auth |

The SDK lab, not CDK, provisions the live proof. Physical names, ingress, sweeper, schedules,
and function/queue counts intentionally differ; see [the comparison](INFRASTRUCTURE.md#lab-comparison).
Notifications are durable records in the local sink, not email or Slack deliveries.

## Verification

Run expensive gates sequentially, with no interactive API using the disposable lab:

```sh
pnpm verify:release
pnpm --filter content-operations exec playwright install chromium
pnpm --filter content-operations run test:browser
# Use a fresh owned lab; this browser suite does not provision it:
pnpm --filter content-operations run local:up
pnpm --filter content-operations run local:provision
pnpm --filter content-operations run test:browser:local
pnpm --filter content-operations run verify:local --confirm-reset
```

The release gate includes workspace tests/builds, generated-app installation/typecheck/
tests/build/doctor, browser dependency boundaries, pkg-guard, and six package dry runs.
It does **not** run Playwright or LocalStack. The app build also writes a browser-boundary
report under `dist/web/`; no server/core-runtime/AWS module may enter that bundle.

Memory browser acceptance uses isolated ports 4436/4437 and desktop/mobile Chromium.
Local browser acceptance uses 4536/4537 and only the real shared workflow in each viewport;
no clock acceleration, host worker, or mocked transport substitutes for deployed work.
Screenshots/traces/reports are Git-ignored. See [browser gates and CI](WORKBENCH.md#verification).

**`verify:local --confirm-reset` is destructive**, typically 15-20 minutes after provisioning.
It performs the real workflow, deployed failure/recovery matrix, sentinel/reset/reprovision
proof, and final teardown. Only a complete gate including teardown records `go` in
`.localstack/<lab-id>-evidence.json`; failures record `no-go` and attempt safe cleanup.
Read the [detailed gate](ARCHITECTURE.md#run-the-application-gate) before running it.
The [iteration outcome](../../docs/iterations/002-content-operations/outcome.md) maps every
acceptance criterion to evidence and lists the checks deliberately not performed.

## Cleanup and Recovery

Stop web/API processes with Ctrl-C first. To discard the owned lab:

```sh
pnpm --filter content-operations run local:down
```

A successful full verification already tears it down. To reset only its owned service
resources, use `local:reset --confirm-reset`, then `local:provision`. Reset erases that
dataset; down discards the whole dedicated emulator. Neither is a production destroy tool.
Images remain cached; there is no Docker-wide prune. Keep the ownership manifest until
cleanup succeeds. Never bypass an ownership refusal or adopt prefix-matching resources.

| Symptom                                                 | Action                                                                                                                                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing workspace CLI on first install                  | Build the workspace before running its CLI; an empty checkout has no compiled `dist/cli.js` yet.                                                                                                           |
| Occupied port / unavailable API                         | Use paired explicit ports, check health, and select the intended runtime; do not kill or reuse another session.                                                                                            |
| No seeded rows / missing seed stage                     | Seed the explicit runtime/port. Existing or partial IDs are skipped; start a fresh disposable dataset if needed.                                                                                           |
| Pending review/asset/publication                        | Read the processing mode and allow bounded eventual work; LocalStack needs deployed workers and automatic jobs. Check editor Operations rather than inventing completion.                                  |
| 409 conflict                                            | Preserve local edits; compare and explicitly select the new base. Retry identical ambiguous intent with the same key, not a new duplicate command.                                                         |
| Failed/stalled publication                              | An editor can retry the current eligible generation. Live leases cannot be overridden; retries preserve the frozen artifact and have a finite budget.                                                      |
| Collected non-publication failure                       | Use owned `jobs:inspect` / `jobs:replay` with a stable request UUID, not arbitrary event submission. [Recovery protocol](ARCHITECTURE.md#failures-and-recovery).                                           |
| Token/plan, inherited AWS config, or endpoint rejection | Correct local prerequisites in a clean shell; never switch to real credentials or a paid trial to make a test pass.                                                                                        |
| Ownership or teardown refusal                           | Keep the manifest and sanitized failed evidence; investigate privately and rerun owned cleanup. [Lifecycle limits](ARCHITECTURE.md#reset-and-stop) explain interrupted provisioning and foreign resources. |
| Cold Lambda readiness timeout                           | Allow the pinned runtime image to pull, then perform owned reset/reprovision and retry. Do not loosen destination/ownership checks.                                                                        |

## Limits and Release Status

This is a single-workspace, bounded development consumer. Bodies are plain text up to
32 KiB, uploads are at most 10 MiB, and content retains at most 10 active / 32 total
attachment slots. Signature checks are not full decoding or scanning. Verified historical
objects and tombstones are retained until explicit reset. Queries are bounded pages, not
global counts or snapshot reads; empty filtered pages can still have continuation.
Memory stores and recovery budgets are finite; see [protocol bounds](ARCHITECTURE.md).

No npm publication, version bump, tag, real AWS deployment, production auth, external
notification provider, or remote CI success is implied by local acceptance. The existing
foundation remains the `v0.0.1` Git baseline; the private consumer is not a published package.
