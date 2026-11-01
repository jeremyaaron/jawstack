# Content Operations API

Local development ingress for the private reference consumer, not production authentication
or a published framework API. The [Angular workbench and typed client](WORKBENCH.md) now
provide content browsing, version-safe draft editing, review submission/decisions/history,
and paged primary activity.

## Start and Seed

From the repository root, after `nvm use`, `pnpm install`, and `pnpm build`:

```sh
pnpm --filter content-operations run dev:api
```

The API binds to `http://127.0.0.1:4327`. In another terminal:

```sh
pnpm --filter content-operations run seed --runtime memory
curl http://127.0.0.1:4327/api/health
curl -H 'x-content-ops-fixture: author_1' http://127.0.0.1:4327/api/content
```

Memory mode runs the real shared handlers, notifications, publication, and due jobs in one
volatile process. A serialized managed loop drains bounded worker batches every second;
due jobs run once per minute. Restarting discards the dataset. SIGINT/SIGTERM abort pending
bodies, stop timers, wait for active work, and close runtime clients.

The deterministic seed uses six fixed content IDs and normal domain commands to create
draft, review, changes-requested, approved, scheduled, and published examples, including
an actual PNG attachment on the published example. Revision/review/asset IDs are generated
normally; due times are relative to the server clock. Existing IDs are skipped, including
partially seeded examples; seeding never overwrites edits. Restart memory to start fresh.

For explicit local DynamoDB/private S3 ingress:

```sh
pnpm --filter content-operations run local:up
pnpm --filter content-operations run local:provision
pnpm --filter content-operations run dev:api:local
# Another terminal:
pnpm --filter content-operations run seed --runtime localstack
```

Startup requires the ready owned lab manifest, table/bucket ownership, private public-access
block, and disabled bucket versioning. All clients use guarded emulator endpoints and dummy
credentials; inherited AWS configuration is rejected. No real-AWS fallback exists. LocalStack
health reports `external-workers`: consumer queue/Lambda/Scheduler deployment is Phase 20,
so related read models, publication, and due transitions are not currently driven in this
mode. Seeding creates authoritative intents, not fake completed worker results. Memory is
the complete interactive workflow today. Stop the API before `local:down` or resetting the lab.

Use explicit overrides if necessary; occupied ports fail without choosing another:

```sh
pnpm --filter content-operations run dev:api --port 4337 --web-port 4336
pnpm --filter content-operations run seed --runtime memory --port 4337
pnpm --filter content-operations run dev:api:local --lab dev --port 4337 --web-port 4336
```

`pnpm --filter content-operations run dev:web` starts the workbench on 4326 with a same-origin
API proxy. The configured web port is its exact allowed Host/Origin. Settings may also use
`CONTENT_OPS_API_PORT`, `CONTENT_OPS_WEB_PORT`, and
`CONTENT_OPS_LAB_ID`; the launchers still select `memory` or `localstack` explicitly.

## Identity and Envelopes

Except health, manifest, and fixture discovery, requests require `x-content-ops-fixture`
with one of `author_1`, `author_2`, `editor_1`, or `editor_2`. The server resolves their
roles. Arbitrary subject/role/claims headers cannot promote callers; internal services
are never selectable. All four fixtures can read the shared workspace. Authors mutate
their own content, editors manage editorial decisions, and operations/seed require editors.
Another local process can select these fixtures: loopback restrictions are not real auth.

JSON responses use `{ok:true,data,meta}` or `{ok:false,error:{code,message,details?},meta}`.
Metadata contains request/correlation IDs, also returned as headers. Optional `x-request-id`
and `x-correlation-id` must satisfy the shared identity schema. A successful idempotent replay
retains the original metadata. Version conflicts return HTTP 409 with `resource.conflict`
and `details.expectedVersion` / `details.actualVersion`. Dependency errors are sanitized;
no stack, SDK response, credentials, bucket configuration, object keys, or fencing tokens
are served. Binary downloads return the bytes, media type, safe disposition, and trace headers.
Publication JSON is redacted; its digest and size describe the verified canonical stored
artifact, not a reserialization of the redacted HTTP envelope.

## Routes

| Method | Path                                               | Input / Result                                                                                                                                           |
| ------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`                                      | Runtime, processing mode, health (`ok` / `degraded`).                                                                                                    |
| GET    | `/api/manifest`                                    | Public resource metadata; no internal commands/workers/schedules.                                                                                        |
| GET    | `/api/fixtures`                                    | The four selectable development identities.                                                                                                              |
| POST   | `/api/resources/contentItem/commands/create`       | Strict `{input,idempotencyKey}`; UUID generated by dispatch.                                                                                             |
| POST   | `/api/resources/contentItem/:id/commands/:command` | Same envelope, allowlisted user commands only.                                                                                                           |
| GET    | `/api/content`                                     | `status`, `authorId`, `title`, `limit`, `cursor`.                                                                                                        |
| GET    | `/api/reviews`                                     | `status`, `editorId`, `overdue=true\|false`, `limit`, `cursor`.                                                                                          |
| GET    | `/api/calendar`                                    | Required `from`, `before` offset instants; `limit`, `cursor`.                                                                                            |
| GET    | `/api/operations`                                  | Editor only; `view=attempts\|notifications\|failures`, `contentId`, `recipientId`, `status`, `limit`, `cursor`. Recipient applies only to notifications. |
| GET    | `/api/resources/:type/:id`                         | Allowlisted `contentItem`, `reviewTask`, or `asset`; `{resource}`.                                                                                       |
| GET    | `/api/resources/:type/:id/activity`                | `limit`, `cursor`; paged activity for an existing resource.                                                                                              |
| PUT    | `/api/uploads/:contentId/:assetId`                 | Raw bytes with exact registered `Content-Type`; author/editor authority and verified readback.                                                           |
| GET    | `/api/assets/:assetId/download`                    | Optional `contentId` locator if the asset read model is not materialized. Strong content slot authority is always checked.                               |
| GET    | `/api/content/:id/publication`                     | Verified committed JSON artifact, digest, size, completion time; never an object merely present in storage.                                              |
| POST   | `/api/development/seed`                            | Editor only, strict `{confirm:true}`; created/skipped IDs. Used by seed CLI.                                                                             |

Review queries additionally accept `contentId` for bounded history filtering. It composes
with assignment/status/overdue filters and is included in continuation scope; callers still
cannot choose storage partitions. Empty filtered pages can retain a cursor.

Public commands are `create`, `editDraft`, `submit`, `approve`, `requestChanges`,
`reopenDraft`, `archive`, `registerAsset`, `removeAsset`, `schedule`, `cancelSchedule`,
`reschedule`, `publishNow`, and `retryPublication`. Inputs are the browser-safe Zod contracts
in `src/shared/presentation.ts`; commands other than create require the current expected
version. Review/publication commands also require their current revision/review/generation
identity as defined by those schemas. Internal snapshot/upload-completion/claim/outcome/job
commands are excluded even for editor fixtures.

Example create:

```sh
curl -H 'x-content-ops-fixture: author_1' -H 'content-type: application/json' \
  --data '{"idempotencyKey":"example-create-1","input":{"title":"Release notes","body":"Draft notes."}}' \
  http://127.0.0.1:4327/api/resources/contentItem/commands/create
```

Reuse an idempotency key only for an identical intent. Queries reject unknown/duplicate
parameters and partition selectors. List queries return `{items,nextCursor?}`; resources
may be visible before asynchronous projections. Default page size is 50, maximum 100;
filtered requests evaluate at most 200 candidates (conservatively charging the requested
service limit). Empty filtered pages can retain a continuation. Cursors are opaque, max
4 KiB, bound to fixture/query/filter/range and the frozen overdue cutoff. Continue with
identical filters; page size may change. Do not infer end-of-list from an empty page alone.
Calendar uses a half-open UTC range of at most 42 days. Archived content is available through
the explicit archived-status query, not the active list. Operations are redacted summaries.

## Transport Bounds

The operations client validates each view's redacted DTO, projection, item identity, and requested
filters. UI retry eligibility uses the same pure rules as `retryPublication`, but is advisory:
the command always reloads authority and checks the server's clock/version/generation/role.
No browser replay, clock-control, fault-injection, or arbitrary worker-dispatch route is exposed.

- Only literal `127.0.0.1` binds/hosts and exact configured API/proxy origins; no broad CORS.
  Cross-site fetches and `Origin: null` are rejected. Native CLI calls can omit Origin.
- JSON: 256 KiB, strict UTF-8 and media type; raw uploads: 10 MiB plus the registered size
  and media signature checks. Compressed bodies, GET bodies, and unsupported methods fail.
- Headers: 16 KiB / 100 entries; request target: 8 KiB; body deadline: 30 seconds.
  Connections: 64; admitted requests: 32; no unbounded request queue.
- Private/no-store responses, `nosniff`, same-origin resource policy, and a restrictive CSP.
  PDF downloads use attachment disposition. Removed verified assets remain available to
  retained historical references; pending/expired/unverified slots do not grant access.

The Angular client's binary PUT uses XHR for real transfer progress with the same fixed fixture
header and a 30-second timeout. Completing transfer does not itself make a slot ready. The client
checks downloaded attachment type/size/SHA-256 against the strong content/snapshot reference.
The publication endpoint returns a redacted view of a verified **stored** artifact. Its `sha256`
and `size` describe canonical private stored bytes, not a reserialization of `artifact`. The UI's
redacted JSON export deliberately retains that distinction; it is not a raw S3 artifact download.

The calendar UI's `date`/`zone`/`view` parameters are presentation state, not new HTTP query
fields. Its typed client converts one local month into the existing calendar endpoint's
half-open `from`/`before` UTC bounds and validates returned scheduled rows against that range.
Detail commands load strong content independently of calendar projection versions. The browser
does not request due publication or expose test clock control; only the runtime's due job does.

HTTP-only workflow, authorization, conflict, paging, body-limit, private read, seeding, and
shutdown tests live in `test/unit/http.test.ts` and `test/unit/api-queries.test.ts`.
The opt-in owned lab gate also executes real HTTP commands/uploads/queries/downloads against
DynamoDB/S3, independently of the later deployed consumer transport.
