# Content Workbench

The Phase 15 Angular consumer runs against the real [loopback API](API.md). It supports
content list/board browsing, URL filters and bounded paging, create/detail, and versioned
draft editing. Review selection/decisions, uploads/preview, calendar, and operations screens
are assigned to the following phases; they are not empty navigation destinations here.

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
authors edit their own drafts, editors edit any draft. Non-drafts are read-only here.

Memory mode manages the real handlers and due jobs. Seed creates six lifecycle examples;
`Release notes: draft` and the changes-requested example are editable by their author or
an editor. Existing seed IDs are never overwritten. The browser does not auto-seed or invent
rows, counts, workflow outcomes, or review decisions.

The workbench can use `dev:api:local` instead, after owned lab startup/provisioning. Its
backend must be selected explicitly; there is no auto-detection or AWS fallback. Consumer
workers are not yet deployed in that mode, so related materialized results remain pending.
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
choose another explicit pair. Browser tests do not use Docker, tokens, or AWS.
Readiness waits for the transformed browser entrypoint, not just Vite's HTML response;
its cold compilation has a 60-second startup bound. Build/development caches are isolated
by command and port, keeping browser tests separate from concurrent workspace builds.
The first full walkthrough has a 60-second budget including cold browser dependency
optimization; other scenarios retain their 30-second bounds. Retries are disabled.

Browser evidence covers paging/filters, list/board, create/save/reload, owner/editor
permissions, actual concurrent-edit conflicts, explicit reconciliation, unsaved route/fixture
guards, return URLs, invalid filters, and long-title/button/document fit. Screenshots and
failure traces are written under Git-ignored `test-results/`; the normal unit command never
launches Playwright. The full release gate remains credential-free; run browser verification
explicitly until the later CI phase wires its dedicated job.

Every Vite build checks the complete module graph and writes `dist/web/browser-boundary.json`.
Node builtins, core runtime, server/domain factories, AWS/Smithy/CDK, and legacy browser shims
are forbidden at resolution and after compilation. Real screen/shared/presentation modules
must be present, so an empty output cannot pass. Unit negative cases cover package and
resolved imports. The browser bundle uses `@jawstack/angular` error/badge/presentation
contracts and only the selected standalone `@lucide/angular` icons.
