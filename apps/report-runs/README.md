# Report Runs

A private, headless inventory-report consumer of JawStack's public workflow APIs.
Request an immutable inventory snapshot, let a worker calculate it asynchronously, and
export the actual stored canonical JSON and SHA-256 digest.

Development fixtures only. This is not production authentication or a real-AWS deploy tool.

## Memory Walkthrough

From the repository root, with the Node version in `.nvmrc` active:

```sh
pnpm install --frozen-lockfile
pnpm --filter report-runs dev:api --seed --confirm-seed
```

The API binds only `http://127.0.0.1:4347`; an occupied port fails without replacing a
server. The optional confirmed seed uses ordinary commands for two fixed reports,
without overwriting existing data. Omit both seed flags for an empty process-local dataset.
One explicitly started shared driver processes committed work; construction/imports start nothing.

In another terminal:

```sh
pnpm --silent --filter report-runs cli request --input examples/inventory.json --key inventory-demo-1
pnpm --silent --filter report-runs cli status --id <report-id>
pnpm --silent --filter report-runs cli result --id <report-id>
pnpm --silent --filter report-runs cli result --id <report-id> --output /explicit/path/inventory.json
pnpm --silent --filter report-runs cli failures --fixture operator_1 --report <report-id> --limit 25
```

Paths passed to pnpm-filtered commands are relative to `apps/report-runs`; use absolute
paths when needed. The request response contains `data.reportId`. Wait for `completed`
before exporting; unfinished results return conflict, never a calculated-but-uncommitted result.
Repeating an equivalent request with the same key returns the original success envelope,
including its original trace metadata. A conflicting request cannot replace the original.
Keys are scoped to command/resource/subject and logically expire after seven days; a new
request after expiry can create a new report. Existing completed reports remain authoritative.

CLI `result` writes verified UTF-8 JSON bytes to stdout, with one trailing LF. File export
requires `--output`, refuses existing files by default and only overwrites with explicit
`--overwrite`. Other successful CLI commands emit JSON envelopes. Errors exit nonzero with
bounded JSON diagnostics. Unknown commands, flags, identities and non-loopback API URLs fail.
`--api http://127.0.0.1:<port>` selects another explicitly running instance.
The examples use pnpm's `--silent` so its script banners do not contaminate machine-readable output.

Fixtures are `requester_1`, `requester_2` and `operator_1`, selected with `--fixture`
(default `requester_1`). Requesters inspect only their own reports/results. Operators inspect
all reports and eligible delivery failures. The internal worker is not a selectable fixture.

## HTTP Contract

Send `x-report-runs-fixture` on every business request. Health is public.
JSON POSTs require `Content-Type: application/json` with optional UTF-8 charset.

| Method / Route                           | Contract                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                        | Runtime plus managed/manual/external-worker processing mode.                                                |
| `POST /api/reports`                      | `{ "input": { "items": [...] }, "idempotencyKey": "stable-key" }`; HTTP 200 for new or replayed success.    |
| `GET /api/reports/:id`                   | Strong-read authoritative resource and delivery reference, under requester/operator policy.                 |
| `GET /api/reports/:id/result`            | Verified stored JSON bytes, ETag and SHA-256 Digest header; 409 while unfinished.                           |
| `GET /api/operations`                    | Operator-only failure summaries; optional `consumer=buildInventory`, `reportId`, `limit` (1-100), `cursor`. |
| `POST /api/operations/:failureId/replay` | Operator-only `{ "requestId": "<stable UUID>" }`; no replacement envelope.                                  |

JSON responses use core-style `ok/data/meta` or `ok/error/meta` envelopes. Exports are raw
canonical JSON, not wrapped envelopes. Invalid input is 400, forbidden 403, missing 404,
conflict/not-complete 409, oversized 413, unsupported media 415 and dependency failure 503.
Responses are private/no-store. Host/optional Origin must match the actual loopback
listener exactly; duplicate boundary headers and query parameters are rejected.

Ingress is bounded to 20 KiB UTF-8 JSON, 16 concurrent handlers, 16 KiB headers and a
30-second body deadline. Responses/CLI reads are capped at 512 KiB. Operations queries
scan at most 200 summaries/20 pages per call; filter-bound cursors preserve continuation
without exposing original failed envelopes. Result export never exposes SDK responses.
SIGINT/SIGTERM stop the managed driver, abort incomplete bodies and close the workflow.

## Canonical Inventory

Input is strictly `{ items: [{ itemId, label, quantity }] }`:

- 1-100 unique, case-sensitive ASCII IDs, 1-64 characters from letters/digits/`_.:-`.
- Labels must be well-formed Unicode without control characters, trimmed and NFC-normalized,
  nonempty and at most 160 UTF-8 bytes.
- Quantities are uncoerced integers 0-1,000,000; total quantity is at most 100,000,000.
- Items sort by ID's UTF-8 byte order. Unknown fields, duplicates and inputs over 16 KiB reject.
- Request validation checks predicted result size (32 KiB maximum) before any commit.

Input digests hash normalized JSON with a trailing LF. Output property order is
`version, reportId, requestedAt, items, summary`; item order is `itemId, label, quantity`
and summary order is `itemCount, totalQuantity, zeroStockCount`. Output has exactly one
trailing LF, and its digest hashes those UTF-8 bytes. Completion time is stored separately,
not included in deterministic output bytes.

`request` commits immutable intent and its fact. `buildInventory` strongly reads authority,
calculates the result and invokes the internal completion command with a stable intent key.
Matching completed authority is read-only success after duplicate delivery, lost acknowledgement,
or marker/idempotency expiry. There is no claim/lease layer or external artifact store.
Completion state, activity and fact commit atomically through the shared adapter.

Delivery failure is not a second report lifecycle. The report remains requested until
actual completion, with shared failure history for operators. Reconciliation recognizes
matching completed authority; replay eligibility compares the stored original request
against current authority and denies completed/mismatched work. A completed report cannot
be relabeled failed by a late collector.

To replay an eligible collected failure:

```sh
pnpm --silent --filter report-runs cli replay --fixture operator_1 --failure <failure-id> --request <stable-request-uuid>
```

The framework owns the ledger, three-cycle budget, targeted envelope, outbox, retry/collector
and completion markers. No arbitrary event-submission, internal completion, delay or fault
route is exposed. Programmatic worker hooks are dependency/test seams only; no production
environment variable enables faults.

## Explicit Hobby Lab

Requires Docker/Compose, a free loopback port 4566 and the existing pinned LocalStack image.
Use an account on Hobby, not a paid trial. Explicitly select an ignored dotenv file:

```dotenv
LOCALSTACK_AUTH_TOKEN=<your token>
JAWSTACK_LOCALSTACK_PLAN=hobby
```

```sh
pnpm --filter report-runs local:up --lab reportdemo --token-file /absolute/path/to/ignored.env
pnpm --filter report-runs local:provision --lab reportdemo
pnpm --filter report-runs seed --runtime localstack --lab reportdemo --confirm
pnpm --filter report-runs dev:api:local --lab reportdemo
```

An existing file elsewhere may be selected explicitly; use `--plan-key` if its attestation
variable has another name. There is no token-file discovery or copying from another app/home.
Only `up` reads the selected file. SDK clients use explicit dummy credentials and guarded
fixed local destinations. Tokens are not placed in manifests, bundles, Lambda env or logs.
Do not inherit real AWS credentials/profiles/endpoints, dump Docker environments, enable
paid trials, or mount credential directories. Hobby is user attestation, not an entitlement audit.

The namespace is `jawstack-report-runs-<lab>`. The finite shared profile provisions one
table/stream, bus, source queue/DLQ and dispatcher/worker/collector with exact grants/logs
and metadata bindings. No bucket, upload provider or schedule is provisioned. Subscriptions
and delivery bounds come from the workflow manifest: timeout 30 seconds, memory 256 MiB,
concurrency two, batch one, visibility 180 seconds and three receives. Source retention is
four days, DLQ retention fourteen days, logs seven days. Workers use the public local
factory's ownership/tag/schema checks and final-destination transport guard.

The local API uses the same CLI/HTTP contract but reports `external-workers`; there is no
host driver or fallback. Run only one emulator at port 4566, never another app's live lab.
Profile/archive changes require owned down/recreation, not silent adoption or startup reset.

```sh
# Destructive proof against a disposable lab; always attempts owned teardown.
pnpm --filter report-runs verify:local --lab reportdemo --confirm-teardown
# Normal manual teardown, without a token or prebuilt archives:
pnpm --filter report-runs local:down --lab reportdemo
```

Proof uses isolated port 4647 and fails if occupied. It exercises real delivery, ordinary
seed commands, pinned request replay, requester isolation, completion markers and verified
HTTP/CLI export, then records sanitized ignored evidence and tears down the owned emulator,
warm Lambda containers and network. If ownership cannot be proven, teardown refuses and
preserves the manifest for inspection. The full live fault/reset matrix and isolated tarball installation belong to
Phase 13; they are not claimed by this happy-path proof.

## Synthesis and Boundaries

```sh
pnpm --filter report-runs test
pnpm --filter report-runs build
pnpm --filter report-runs synth:local --lab reportdemo
```

CDK synthesis uses the public opt-in recoverable workflow construct and shared subscriptions.
Its longer function-name layout limits CDK lab IDs to eleven characters; the SDK lab supports sixteen.
Its base API Gateway and outbox sweeper are deliberately not deployed by the SDK lab.
The Gateway adapter relays the same tested report routes; the sweeper uses the shared outbox.
CDK's `-local-resources`/named-function layout differs from the SDK lab. Executing those
assets requires a separately ownership-proven deployment with matching owner/profile tags
and metadata; synthesis does not provide that authorization or an AWS deploy command.

All maintained runtime imports are public `@jawstack/core`, `@jawstack/aws-runtime` and
the intentional `/local` subpath. Private `@jawstack/local-lab` appears only in workspace
launch/build/proof scripts, not runtime code or Lambda bundles. There are no Content,
private-package or deep framework imports in installed runtime code, and no hand-written
transaction, pump, collector, replay-store or provider algorithms.
