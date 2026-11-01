# Content Workbench

The Angular consumer runs against the real [loopback API](API.md). It supports
content list/board browsing, URL filters and bounded paging, create/detail, and versioned
draft editing, submission, review queues/snapshots/decisions, paged activity, attachment
uploads/downloads, committed publication previews, scheduling, and a zoned month/agenda.
It also includes editor-only operations views and versioned publication recovery.

## Run Locally

From the repository root:

```sh
nvm use
pnpm install
pnpm build
pnpm --filter content-operations run dev:api
```

In another terminal:

```sh
pnpm --filter content-operations run seed --runtime memory
pnpm --filter content-operations run dev:web
```

Open `http://127.0.0.1:4326/content`. Vite proxies `/api` to `127.0.0.1:4327` with no
Node HTTP shim or browser AWS client. The fixture selector resolves the fixed author/editor
identities through the server. Selection persists locally when browser storage is available;
it is development identity, not secure authentication. All fixtures can read the workspace;
authors edit their own drafts, editors edit any draft. Non-draft bodies are read-only;
eligible content can explicitly reopen to draft, invalidating its current review/approval.

Memory mode manages the real handlers and due jobs. Seed creates six lifecycle examples;
`Release notes: draft` and the changes-requested example are editable by their author or
an editor. Existing seed IDs are never overwritten. The browser does not auto-seed or invent
rows, counts, workflow outcomes, or review decisions.

The workbench can use `dev:api:local` instead, after owned lab startup/provisioning. Its
backend must be selected explicitly; there is no auto-detection or AWS fallback. Consumer
workers, collectors, and recurring jobs are deployed in that mode. Related views and
publication outcomes update asynchronously through the real stream/bus/queue/Lambda path.
See [API mode limits](API.md) before using the resettable LocalStack dataset.

For alternate loopback ports, configure both processes consistently:

```sh
CONTENT_OPS_API_PORT=4337 CONTENT_OPS_WEB_PORT=4336 pnpm --filter content-operations run dev:api
CONTENT_OPS_API_PORT=4337 CONTENT_OPS_WEB_PORT=4336 pnpm --filter content-operations run dev:web
pnpm --filter content-operations run seed --runtime memory --port 4337
```

Occupied ports and non-loopback Vite host overrides fail explicitly. No shared existing
server is adopted by tests. The root `pnpm dev:web` still runs the original Work Requests
demo; the filtered commands above select this consumer.

## Draft Safety

- Create/save uses the shared Zod contracts, UTF-8 body bounds, expected resource version,
  and one idempotency key per unchanged actor/target/input intent. Pending saves cannot be
  submitted twice. Ambiguous network retries reuse the intent rather than creating duplicates.
- A 409 retains the local form and blocks further saves until comparison. `Compare latest`
  fetches server text without replacing the draft. `Use server draft` explicitly discards
  local text; `Keep local draft` explicitly adopts the displayed server version as its new
  base. If that version changes again, another 409 protects it. 403/network errors retain text.
- Route navigation, refresh, and fixture changes confirm before discarding unsaved edits.
  Pending mutations block navigation/identity switching. Browser unload triggers the native
  warning; declining it retains the page, but this is not persisted offline draft storage.
- Query parameters preserve status/title/author filters and list/board mode. An opaque
  `cursor` and bounded `limit` support direct pages; load-more state is in memory. View
  switching preserves loaded rows. Empty filtered pages can still offer continuation.
  Counts describe loaded rows, not a fabricated total or a complete-board claim.

## Reviews and Activity

On content detail, submit a saved draft with an assigned editor and a future due time.
The date/time field is explicitly UTC, converted by the shared strict Temporal helper.
Unsaved body edits block submission. `Open review` leads to the exact submitted title/body,
revision, attachment metadata, assignment, and deadline, not a mutable draft preview.

`/reviews` defaults to pending tasks. Status, assignment, overdue, and optional `contentId`
history filters live in the URL. `status=all` is a UI alias for omitting the API status filter.
History and activity are paginated, with explicit continuation even after an empty filtered
page. History uses a bounded content post-filter on existing review partitions; it does not
introduce an unbounded scan or pretend one page contains every review for that content.

Either editor can request changes or approve the loaded current review, with a nonblank
decision note. Authors can inspect snapshots/outcomes but cannot decide them. Decisions
always target `contentItem` with its loaded version, review UUID, and submitted revision;
the secondary row's optimistic version is never used as content authority. A stale response
preserves the note and requires explicit refresh. A historical review cannot approve a new
revision, even after refresh. Unrecorded notes remain visible and can be explicitly discarded;
navigation and fixture changes protect them. Ambiguous retries retain their idempotency key.

The content's strong authoritative snapshot can be shown while the review row is missing or
behind, using the content locator carried by its link. The pending/synchronizing banner is
explicit; this is not a fabricated read-model row. Visible pending views poll every two seconds,
back off to ten seconds after one minute, pause/abort on hidden tabs, and stop on settlement
or destruction. Polling never refreshes the loaded decision base. Without a matching authoritative
snapshot or materialized historical row, the view reports unavailable instead of inventing history.

Content/review pages display the primary content activity, five records at a time, with links
to retained review snapshots. Refresh is explicit; user commands refresh the current version.
Success focus moves to the review link or recorded decision, and invalid notes focus their field.

## Attachments and Publication

Saved drafts accept nonempty PNG, JPEG, and PDF files up to 10 MiB, subject to the domain's
10-active/32-retained-slot limits. The native file control validates the shared safe-name,
media-type, and size contracts before registration. The server also validates signatures,
ownership, deadlines, and actual streamed bytes; these are not malware scanning guarantees.

Registration and binary transfer are separate operations. Progress is actual XHR transfer
progress; 100% means verification is still pending. Ready state comes from a fresh strong
content read, never an eventual asset row or a local file preview. Errors/cancellation retain
the selected File and pending slot for retry. A lost registration response reuses the exact
input/key; retrying a registered slot never silently creates another attachment. After a
reload, a pending slot accepts a reselected file with matching name/type/size; the server
still verifies its actual bytes. Uploads have a 30-second deadline and support cancellation.
Discarding a selection does not remove its registered slot. Removal is an explicit versioned
command; retained tombstones and historical verified bytes follow the existing domain policy.

Dirty text blocks attachment mutations, and pending media mutations block text/review changes,
navigation, and fixture switching. Selected files trigger the discard guard. A 409 preserves
both selected file and loaded text/version until explicit refresh; existing submission input
is not reset by attachment updates. Successful upload returns keyboard focus to the file control.

Image thumbnails and downloads use authenticated private reads, with exact media-type, byte-size,
and SHA-256 checks against verified references. Blob URLs are revoked when replaced or destroyed;
requests abort on teardown/identity changes. PDFs are download-only, never embedded documents.
Published attachment membership and bytes remain read-only; snapshot downloads remain usable.

Editors can publish an approved snapshot with its loaded content version and exact approval
review/revision. Ambiguous retries retain their command key. Queued/running outcomes poll strong
authority only while visible, with the shared 2-second/10-second backoff and teardown rules;
failed/stalled outcomes remain locked and visible, not fake successes. Recovery controls remain
Phase 19. Only a succeeded, committed publication can load a preview. That endpoint reads and
verifies the actual stored artifact, not a reconstruction from mutable form text.

`Download redacted JSON` exports that verified artifact's public view, without object keys or
fencing tokens. Its attachment references use the same guarded downloads. Displayed **stored
artifact** size/SHA-256 describe the canonical private stored bytes, not the reformatted/redacted
JSON export; no byte-identical canonical download is exposed to the browser.

## Scheduling and Calendar

Editors can schedule approved content, reschedule the current schedule, or cancel it back
to approved. The form uses an explicit local date/time and IANA zone, with a UTC-instant
preview. Shared Temporal conversion rejects nonexistent and repeated wall-clock times rather
than choosing an offset. Native local inputs may shorten fractional seconds; one-to-three
digits normalize to the same exact three-digit UTC contract. Client and server both require a future instant; the server clock
remains authoritative. Reschedule/cancel include the loaded content version, revision, and
exact schedule generation; schedule/reschedule also carry the approved review/revision.
Owning authors or editors can reopen scheduled content, invalidating both schedule and approval.

Dirty schedule proposals are protected on route/fixture/refresh/unload; pending commands block
other mutations and leaving. Cancelling/reopening confirms before discarding a proposal.
Conflicts preserve the proposed time/zone and loaded base until explicit refresh. Ambiguous
command retries retain their intent keys, including when a committed command's following read
is lost. Schedule success/validation focus is explicit and all actions support the keyboard.

Scheduled detail pages poll visible strong authority for due outcomes, using the same serialized
2-second/10-second backoff and cleanup as publication. Remote reschedule/cancel/reopen does not
silently replace the loaded command base; refresh is explicit. When the actual due job starts
publishing, controls lock; an unsubmitted local proposal remains visible/copyable/discardable.
There is no browser publication timer or automatic publish-now request. Memory mode evaluates
due jobs at most once per minute, so a passed scheduled instant is not immediate success.
LocalStack requires the later deployed consumer jobs/workers, as described above.

`/calendar` keeps `date=YYYY-MM-DD`, `zone`, `view=month|agenda`, optional `limit`, and an opaque
fixture-bound `cursor` in the URL. Its API query covers the first valid local instant of the
month through the start of the next month, converted to a half-open UTC range. Even DST-changing
months stay below the API's 42-day bound. The fixed 42-cell Monday-first grid mutes outside-month
dates without claiming those days were queried. Counts and day entries describe loaded rows,
not a complete month; explicit load-more is bounded and empty pages can retain continuation.

Month and agenda share exactly the same loaded instants. Display zone changes regroup the UTC
instants into local dates; agenda timestamps include their offsets/zone abbreviations. Narrow
month cells expose loaded counts and ordinary day buttons switch to the month agenda, with
the selected date highlighted. Links open strong content detail and preserve calendar URL
context on return, including after reload. Fixture changes reset scoped continuations, including
when the fixture was changed on a linked detail page. Calendar
refresh is explicit; rows that leave scheduled state disappear from its next query rather than
becoming invented publication-history entries.

## Operations and Recovery

`/operations` has publication-attempt, notification, and failure views. URL filters select
`view`, optional content UUID, status, notification recipient, bounded `limit`, and scoped
`cursor`. Invalid view/status combinations fail before fetching. Authors see an access-denied
state, not an empty privileged dataset; the API independently requires an editor. Switching
fixtures clears privileged rows and resets fixture-bound continuations.

Records are actual redacted server DTOs. Attempts show generation, recorded stage, claim/finish
times, failure code, source/transition/correlation/causation IDs. Notifications describe the
local sink's completed deliveries, not external email or invented pending notifications.
Failure details include resumable collection and recorded recovery history, without the stored
original payload. Native disclosure controls expose trace details; links lead to strong content,
review history, and retained review snapshots where a review reference is present.

Selecting a content UUID also loads its strong publication authority. The same recovery widget
appears on content detail. It distinguishes queued/running/succeeded/failed from an expired-lease
stalled display, retaining the recorded phase and lease deadline. A stalled display does not
claim execution definitely failed. Lease-age display uses the browser clock; the server always
rechecks its own clock, active claim, version, publication ID, generation, role, and budgets.

Eligible editors can explicitly retry failed/stalled work, including an expired claim or a
current failed attempt awaiting automatic delivery retry. A live claim forbids retry. Each
generation permits three execution attempts; the four-generation ceiling allows at most three
manual generation advances. The UI displays these separate budgets. Retry preserves the frozen
publication identity and artifact; a stored-but-uncommitted object is still not a preview.
Unchanged retries after ambiguous network errors reuse the exact input/key. A 409 keeps the
loaded base and requires explicit refresh. An acknowledged retry whose following read fails
is displayed as awaiting status, not invented success. Pending mutations/reads protect route,
query-view, fixture, and unload navigation and disable competing controls.

Visible pending publication authority polls serially every two seconds, backing off to ten
after one minute. It pauses/aborts while hidden and stops on settlement/expiry/destruction.
The initial operation page also follows pending records or selected pending publication;
appending a page deliberately makes that ledger a **Snapshot**. Background refresh never
silently drops explicitly loaded pages. The selected strong publication can continue following
independently. Ledger refresh is explicit after settlement; distributed notification arrival
is not assumed complete merely because publication completed. Queries remain individually
bounded and no background scan walks the entire history.

Consumer replay remains the development [jobs CLI](README.md#failures-and-recovery),
not a browser action or new HTTP endpoint. Publication failures use the explicit publication
retry command rather than replaying an old publication delivery. Non-publication records retain
the existing three-cycle replay budget, allowlisted consumer, and original business identity.

## Verification

```sh
pnpm --filter content-operations run test
pnpm --filter content-operations run build
pnpm --filter content-operations exec playwright install chromium
pnpm --filter content-operations run test:browser
pnpm verify:release
```

`vitest.config.ts` includes only `test/unit/**/*.test.ts`. Playwright discovers only
`test/browser/**/*.spec.ts` and owns separate seeded memory/Vite servers on 4437/4436.
It refuses occupied ports, runs 1440x900 desktop and 390x844 mobile workflows, and gracefully
stops its child servers. Optional `CONTENT_OPS_E2E_API_PORT` / `CONTENT_OPS_E2E_WEB_PORT`
choose another explicit pair. This default memory suite does not use Docker, tokens, or AWS.
Readiness waits for the transformed browser entrypoint, not just Vite's HTML response;
its cold compilation has a 60-second startup bound. Build/development caches are isolated
by command and port, keeping browser tests separate from concurrent workspace builds.
The complete content/editorial walkthroughs have 60-second budgets including cold browser
dependency optimization; focused scenarios retain their 30-second bounds. The shared automatic
publication workflow has a four-minute budget, including a three-minute automatic publication
wait. Both suites have a ten-minute global deadline, one worker, and no retries.

Browser evidence covers paging/filters, list/board, create/save/reload, owner/editor
permissions, actual concurrent-edit conflicts, explicit reconciliation, unsaved route/fixture
guards, return URLs, invalid filters, full changes-request/resubmission/approval, historical
snapshots, stale-review rejection, paged activity, real media transfers/downloads/publication,
DST validation, zoned calendar paging/navigation, schedule conflicts/reopen, keyboard focus,
and fit. Scheduling browser tests use an additional per-test loopback memory API with an injected
clock. Only the test host advances that clock and runs the real due jobs/publisher; there is no
public clock-control endpoint, fake artifact, or direct publish command substituting for a due job.
All cases use a shared acceptance fixture that rejects uncaught browser errors and horizontal
clipping/heading/control overflow, checks header/content separation, and captures a successful
final screenshot. Keyboard checks exercise the skip link, primary navigation, route focus,
validation focus, fixture persistence and editor-only operations. Query-failure recovery must
not masquerade as an empty result. Existing route/fixture/conflict guards remain active.

Screenshots and retained failure traces are written under Git-ignored `test-results/memory/`;
`test-results/memory-results.json` records the actual result. The normal unit command never
launches Playwright. Both a successful and failed browser run must release its owned ports;
existing interactive web/API processes are never reused or stopped. Run heavyweight release,
browser and Docker gates sequentially on constrained machines.

### LocalStack Browser Acceptance

Use a disposable, provisioned Hobby lab, following the [lab setup](README.md#run-the-application-gate).
This test creates real content; it does not reset an existing dataset or provision implicitly.
The default `dev` lab can be overridden consistently for every command:

```sh
CONTENT_OPS_LAB_ID=e2e23 pnpm --filter content-operations run local:up
CONTENT_OPS_LAB_ID=e2e23 pnpm --filter content-operations run local:provision
CONTENT_OPS_LAB_ID=e2e23 pnpm --filter content-operations run test:browser:local
CONTENT_OPS_LAB_ID=e2e23 pnpm --filter content-operations run verify:local --confirm-reset
```

The final command is the separate full integration/failure/reset/teardown gate. Successful
verification already performs down. After a browser or integration interruption, use
`local:down` with the same lab ID if its manifest remains; never delete containers by prefix.
An already-removing child is awaited by exact ID for up to thirty seconds, after its
ownership is proven. Unknown/foreign/stuck inventory is refused and retains the manifest.

`playwright.local.config.ts` selects only the shared `workflow.spec.ts` on desktop/mobile,
starts its own API/web on 4537/4536, and verifies `localstack`/`external-workers` health.
It uses actual browser create/upload/submit/editor approval/schedule/calendar/preview/download
and paged operations flows, with read-only API checks for real asset/review materialization,
published authority and three notifications. The actual image must render and the downloaded
artifact must match the content/attachment identity without private storage fields. Publication
comes from the automatic due job and deployed publisher, not a host pump, injected clock,
direct worker, or intercepted success response. Memory-only injected failure/clock tests are
not selected by this config; deployed fault coverage belongs to `verify:local`.

Results are written to `test-results/localstack/` and `test-results/localstack-results.json`.
The token is not needed by either API or web server; use the ignored lab dotenv file rather
than a browser/Vite variable. The server child environments explicitly clear the token.

### CI and Diagnostics

The normal [CI workflow](../../.github/workflows/ci.yml) has only PR/manual triggers.
It runs the credential-free memory browser job after workspace verification, with an actual
browser-boundary build and Chromium installation. No PR job references LocalStack secrets,
starts Docker, or uses `pull_request_target`. Workflow tokens have read-only repository
permissions and checkout does not persist credentials. Node follows `.nvmrc`.

The separate [local integration workflow](../../.github/workflows/content-operations-local.yml)
is manual and default-branch-only. **Before adding its token**, configure the `localstack-hobby`
GitHub environment to allow only the repository default branch and require approval where
available. Store `LOCALSTACK_AUTH_TOKEN` as an environment secret, not a repository-wide secret,
and set the environment variable `CONTENT_OPS_LOCALSTACK_PLAN=hobby` after confirming the
account is Hobby, not a paid trial. The workflow must first be merged to the default branch
to be available for dispatch. No remote run or environment configuration is implied by local
test results. See [GitHub environment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

Only preflight and lab startup receive the token. Missing token/attestation prints `NOT-RUN`,
writes that status to the job summary, and exits unsuccessfully before Docker starts; it is
never a passing integration check. The job builds, runs the real browser path, runs the full
integration gate, and attempts ownership-checked down in an `always()` step. It uses an
isolated hosted runner, a 50-minute job deadline, finite step budgets, and non-cancelling
concurrency. Hard runner termination is not reported as verified cleanup or a passing gate.

Artifact upload is restricted to the selected runtime's screenshots/traces/JSON, the browser
boundary report, and the specifically copied sanitized integration evidence. No dotenv,
manifest, whole hidden directory, Docker dump, or raw service log is uploaded. A pre-upload
check refuses symlinks, excessive traversal, more than 300 files or 100 MiB; refused uploads
fail rather than silently discard diagnostics. Accepted artifacts expire after seven days.
The same check is available locally:

```sh
pnpm --filter content-operations run diagnostics:browser memory
pnpm --filter content-operations run diagnostics:browser localstack
```

Every Vite build checks the complete module graph and writes `dist/web/browser-boundary.json`.
Node builtins, core runtime, server/domain factories, AWS/Smithy/CDK, and legacy browser shims
are forbidden at resolution and after compilation. Real screen/shared/presentation modules
must be present, so an empty output cannot pass. Unit negative cases cover package and
resolved imports. The browser bundle uses `@jawstack/angular` error/badge/presentation
contracts and only the selected standalone `@lucide/angular` icons.
Detail/review/calendar routes are lazy-loaded, and Temporal is prebundled for development to avoid a
dependency-discovery reload during navigation. Production output remains split into bounded chunks.
