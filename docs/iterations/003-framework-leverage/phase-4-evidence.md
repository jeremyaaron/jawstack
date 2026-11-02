# Phase 4 Evidence: Public Memory Workflow Composition

Status: complete, uncommitted for user review. Clean release and installed-package recipe
verification passed. Review patch is based on `738f8d1efbb7efc870621923f743c5b2f7c187e8`.
No staging, commit, push, version bump, publication or deployment occurred.

## Delivered

- `defineWorkflow` validates resource/event/record/consumer registration, derives
  subscriptions from existing workers, rejects missing/extra/inherited bindings and mixed
  delivery profiles, and emits a deeply frozen function-free manifest. Its hash includes
  command names/roles/emissions and selected configuration, not schema/function bodies.
- `createMemoryWorkflow` exposes complete dispatch/read/query/typed-record/operations/
  event/delivery services, bounded manual draining and explicit driver/close lifecycle.
  It uses the existing command engine, shared atomic planner/backing and failure service.
  There is no application SDK transaction, custom pump, startup timer or default handler.
- The public backend adapter-author contract `createWorkflowRuntime` requires every
  storage service and supplies bound planner/failure-protocol/manifest helpers. Storage
  adapters supply conditional persistence, not a copied executor or recovery protocol.
- Registered strict stable payload schemas normalize canonical wire values. Pure
  identity validators must return true. Tenant, source/version/identity/outer wrapper
  mismatches and command-authored or unrecorded recovery metadata reject before effects.
  Operational projections are reserved against decisions/contributions and ordinary reads.
- Delivery authorizes targeted recovery before all marker lookups, including cache hits
  and ignored fanout. Business completion precedes durable recovery completion, then a
  successful marker. Collector acknowledgement similarly follows durable reconciliation.
  Capacity deferral retains work rather than turning it into a failed business attempt.
- The memory pump serializes drains, admits complete fanout before cursor advance,
  retains pending/terminal work, checks consumed boundaries/transport-ID reuse and uses
  injected-clock retry cutoffs. Job, marker, collector-marker and failure capacities are
  bounded; live work is never evicted for admission. Draining does not advance time.
- Binding service guards extend to deferred asynchronous descendants. Drivers start only
  explicitly, stop permits restart, and close aborts/waits with a finite timeout. A handler
  cannot drain/start its own pump. Uncooperative work reports timeout, not false cleanup.
- [Core public recipe](../../../packages/core/workflows.md) and a public-import-only
  test fixture demonstrate commands/contributions, domain handling and authorized replay.
  The recipe is included in the core package file list. No application runtime was migrated.

## Boundaries

This is process-local memory composition, not a Dynamo implementation or proof of live
service durability. The Dynamo factory, batch/queue-ARN AWS wrappers and actual transport
remain later phases. Existing Content Operations/Work Requests APIs and writers are
unchanged. The default composition rejects unrecorded/two-field legacy recovery traffic;
later Content migration must retain any explicitly selected trusted parse-only exception
without granting durable replay authority.

Markers remain deduplication aids, not distributed locks. Concurrent handlers can both
enter before a marker; application immutable identity, source-version/fence checks and
conditional effects remain required. Reconciliation and the ledger are separate
transactions. Trusted callbacks/raw backing maps are not a JavaScript security sandbox.
The manifest hash does not prove equivalent executable code or authenticate an input.

Stop/close are cooperative: a handler ignoring the supplied signal may outlive a timeout.
Closing rejects new operations and reports the timeout; it cannot terminate arbitrary
application code. Lifecycle commands belong outside handlers. Memory backing is owned
and append-only; resets require a complete fresh runtime, not clearing selected maps.

## Verification

Core typecheck/lint/build and all **344 core tests** passed, including **74 new tests**:
62 public-flow/declaration/binding/record/event/pump/lifecycle tests, ten real-port adapter
fault tests and a fresh-import/no-application-I/O test. The small reusable fixture imports
only supported core exports. Adapter fault tests deliberately use real internal memory
ports, not copied protocol implementations or an alternate shipping app writer.

Coverage includes actual primary state completion and auxiliary reads; terminal collection
and authorized replay; exact wire compatibility; authorization before processing/collector
marker reads; non-target fanout; business -> ledger -> marker order; unavailable completion
and marker writes; concurrent handler entry; full-fanout admission; all four capacity limits;
seven-day expiry; duplicate collected transport facts; reset/identity conflicts; deferred
retry time; serialized draining; bounded stop/close and cancellation with an external signal.

Two new Angular-package tests cover source and flattened legacy resource-only bundles.
An audit of the packed-style root found retained unused async-context constructors; pure
allocation annotations now allow those unused backend contexts to be removed. The tests
use TypeScript ASTs to distinguish actual constructor calls from harmless retained external
import declarations. No browser shim, application import rewrite or boundary exemption was
added. Existing legacy/public assertions remain unchanged.

Development checks also caught a consumer-policy DTO mismatch between manifest bounds and
the narrower failure protocol, opaque declaration naming, test timer restoration order,
deferred binding calls, and an omitted collection-marker admission check. Fixes and their
regressions are included in the final full run, not inferred from earlier passing subsets.

A fresh clone `/tmp/jawstack-iteration3-phase4-verification` overlays Git-visible source
on the commit above, excluding ignored dependencies, outputs, tokens, manifests,
benchmark raw data and interactive review data. After the final source overlay, ran
`pnpm install --frozen-lockfile` then `pnpm verify:release`, **tests before package builds**,
without a preparatory build.

| Gate                         | Actual result                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean frozen install/release | Passed on Node 24.16.0 / pnpm 10.21.0.                                                                                                              |
| Workspace tests              | 1,044 passed: core 344, AWS runtime 76, CDK 36, Angular 44, CLI 20, generator 7, Work Requests 2, Content 515.                                      |
| Tooling/compatibility        | Eleven Node tests and one frozen golden test passed; 1,056 primary release tests, excluding the separate generated fixture's two tests.             |
| Typecheck/lint/format/build  | Passed in the clean clone.                                                                                                                          |
| Browser boundaries           | Angular package/consumer checks and both resource-only constructor regressions passed; package report retained 329 modules and zero server imports. |
| Package guard                | Zero errors, warnings or info; no new suppression.                                                                                                  |
| Generated app                | Install/lint/typecheck/two tests, browser and AWS builds, synth and doctor passed; doctor had no findings.                                          |
| Package dry runs             | All six passed; core is six files / 250,522 bytes unpacked, including the shipped workflow recipe. Nothing published.                               |

Release log `/tmp/jawstack-phase4-release.log`: created `2026-11-02T00:00:04.651Z`, last
written `2026-11-02T00:03:15.415Z`, SHA-256
`86c568dd552dc8cec023b761c43b4c7ba6e1d7a29744cc30f384e81512276a65`.
These are log timestamps, not agent-effort measurements. `/tmp/jawstack-phase4-install.log`
retains the known missing prebuild workspace CLI-bin warning. Existing browser
externalization/CDK feature-flag/build-timing notices remain nonblocking; zero findings
above applies specifically to package guard/doctor.

All 35 core source/test and Angular test files match the clean clone. SHA-256 of their
sorted `[path, fileSha256]` list:
`984fe977310dbcbe7a05246ea45efa505a2b041b4b106d2a8b785660402da3c1`.
Final status/evidence/index changes after the gate are Markdown only and covered by
format/link/diff audits. No fresh full Content browser suite, LocalStack table/transport
scenario or real AWS call ran. Earlier evidence is not relabeled a fresh live pass.

## Installed Recipe

Packed the clean clone to `/tmp/jawstack-phase4-packed/jawstack-core-0.0.1.tgz`; SHA-256
`7a9daefcea40c4394dc93a61d73df852bd779195d644df948680c55a1bc4da57`.
Installed that tarball plus Zod 4.4.3 into `/tmp/jawstack-phase4-installed-smoke` with
`pnpm install --ignore-scripts --prefer-offline`. The external fixture initially had no
Node pin; adding the same local `.nvmrc` allowed its commands to run on the workspace's
Node version. No source/package workaround was used.

Mechanically extracted the first two TypeScript blocks from the **installed** `workflows.md`,
exporting their top-level variables for an assertion harness. Typechecked them with
TypeScript 5.9.3, strict/exact optional checking, NodeNext module resolution and
`skipLibCheck: false`. The external tsconfig has no workspace paths/source alias; the only
workspace-provided tooling is the compiler and Node type declarations.

Executed the resulting ESM against the installed package. Assertions verified actual
`node_modules/.../@jawstack/core/dist/index.js` resolution, rendered `A DRAFT` output,
typed receipt version 1, no pending jobs, two outbox facts and resolved recovery generation
1, without an original envelope escaping inspection. Logs:
`/tmp/jawstack-phase4-installed-install.log`, `...-installed-types.log` and
`...-installed-recipe.log`. This is narrow independent public memory/API proof, not the
Report Runs installed consumer or live transport gates planned for Phase 13.

## Growth and Integrity

The frozen counter reports core growth from **4,794 to 6,227 token-lines**, **+1,433**
this phase and +3,626 since the frozen baseline. The root gains **three value exports**
(`defineWorkflow`, `createMemoryWorkflow`, `createWorkflowRuntime`) and **27 named types**.
That count does not hide the member surface: services/delivery/driver methods, binding
hooks, manifest and backend storage ports are real additional concepts. Package bytes
also grow from 131,812 to 250,522 as the previously internal protocols become usable
compiled services. No new package, dependency, version or export-map subpath was added;
the package file list now includes the public recipe.

Selected consumer protocol code remains **1,589 token-lines**, with separate lab code
1,552. No retirement or measured agentic leverage improvement is claimed before migration
and post exercises. Frozen input hashes and inventory remain unchanged; baseline worktrees,
task packets and raw results are untouched. The baseline was not refrozen to hide growth.

App/runtime/CDK source, lockfile and versions remain unchanged. Read-only checks confirmed
the existing 4337 review item remains version 3 / draft. No interactive process/data was
restarted/reset, env/token read, Docker/lab started, remote workflow dispatched or secret
configured. The staged diff remains empty.

Next: Phase 5 implements Dynamo workflow storage against this functioning shared contract,
including an isolated owned local-table transaction probe. Full application migration,
Report Runs reuse and leverage acceptance remain later gates.
