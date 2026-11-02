# Phase 6 Evidence: SQS Binding and Public Local Runtime

Status: complete, uncommitted for user review. Review base:
`75c045991193e2673b6ff2a273cda22aa7624bd4`. No staging, commit, push, version bump,
publication, remote workflow dispatch or real AWS deployment occurred.

## Delivered

- Root `createWorkflowSqsHandlers` binds one registered consumer to distinct exact source/
  DLQ ARNs. It captures the complete bounded batch before yielding, checks queue/region/
  event source/message identity, and validates schemas/subscriptions/outer-inner fact identity.
  Every recovery is authorized before any batch marker/effect, including duplicate markers
  and non-target fanout. Per-delivery authorization is repeated by the common core service.
- Worker and collector handlers use core's existing delivery/recovery ordering, not a copied
  marker/replay protocol. Deferred or failed work throws for whole-batch retry; there is no
  partial response/deletion API. Default batch size is one, up to ten only by declaration.
  Earlier successful effects are not falsely described as part of a batch transaction.
- Intentional `@jawstack/aws-runtime/local` exports pure `parseLocalWorkflowBindings`,
  `createLocalAwsTransport` and async `createLocalWorkflow`. Version-1 routing is bounded
  to 64 KiB, finite plain JSON, exact registered worker/collector pairs and project-prefixed
  names. Optional services are only bucket/schedule-group names. No secrets, credentials,
  endpoints, file/code paths or callbacks are accepted as routing data.
- Local construction checks the owned workflow definition and independent expected lab/
  profile identity, plus exact Lambda function/role/consumer/ARN context when selected.
  Inherited unsafe AWS settings reject before SDK calls. Fixed dummy credentials, region,
  endpoints, finite attempts/timeouts and final HTTP destination checks provide no real-AWS
  fallback. Matching LocalStack bridge/credential metadata is never used as transport input.
- Startup verifies exact ACTIVE table ARN/name/string PK/SK schema and owner/lab/workflow/
  profile tags before application binding. Failure disposes the owned client. Successful
  runtimes use the shared Dynamo storage and core close lifecycle; rejected close calls
  cannot destroy a ready client, and controlled close disposes it once.
- Small supported core helpers `getWorkflowManifest` and `copyWorkflowJson` reuse owned
  definition and finite JSON validation without private imports or another validator engine.
  Source aliases explicitly select `/local` before root-prefix aliases. Package builds/dry
  runs now require compiled local JS/declarations; the local API is not reexported from root.
- Shipped [local/SQS recipe](../../../packages/aws-runtime/local.md),
  [Dynamo recipe](../../../packages/aws-runtime/workflows.md) and
  [core adapter notes](../../../packages/core/workflows.md#adapter-authors) describe usable
  composition, ownership tags, environment policy, resource naming and remaining boundaries.
  No existing application writer/transport/provisioner was migrated.

## Verification

Final verification used a fresh clone at
`/tmp/jawstack-iteration3-phase6-final2-verification`, overlaid with Git-visible source only.
Ignored dependencies/builds/tokens/manifests/raw benchmark and review data were excluded.
Ran `pnpm install --frozen-lockfile` then `pnpm verify:release` on Node 24.16.0 /
pnpm 10.21.0, tests before builds, with no preparatory build.

| Gate                        | Actual result                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace tests             | 1,219 passed: core 345, AWS runtime 250, CDK 36, Angular 44, CLI 20, generator 7, Work Requests 2, Content 515.                             |
| Tooling/compatibility       | Eleven Node tests and one frozen compatibility test passed: 1,231 primary release tests, excluding the generated fixture's two tests.       |
| New regressions             | 106 AWS tests: 27 SQS, 78 local routing/transport/startup/lifecycle, one additional isolated-subpath import test.                           |
| Typecheck/lint/format/build | Passed in the fresh clone.                                                                                                                  |
| Browser boundaries          | Source/flattened resource-only regressions and consumer boundaries passed; Angular report remains 329 modules, zero server imports.         |
| Package guard               | Zero errors, warnings or info; no new suppression.                                                                                          |
| Generated app               | Install/lint/typecheck/two tests, browser/AWS builds, synth and doctor passed; no doctor findings.                                          |
| Package dry runs            | All six passed, including explicit local JS/types checks. Core: six files / 254,124 bytes; AWS runtime: ten files / 132,904 bytes unpacked. |

Coverage includes invalid final records before earlier effects, duplicate message IDs,
ten-record opt-in, captured mutable ingress, recorded/forged/non-target recovery before
markers, whole-batch handler failure, deferred admission, unsafe inherited credentials/
profiles/endpoints, final native HTTP rejection, exact Lambda context, ownership mismatches,
tag pagination/duplicates, client cleanup, invalid/read-only close calls and import-only I/O.
Default tests use SDK/native-handler doubles and require no Docker, secrets or service listener.

The first clean run caught an existing Content source-alias assertion that assumed every
entrypoint was `index.ts`. Its extension allows only the exact intentional `/local` path,
retains root assertions and imports the local API through the app's actual unit aliases.
It does not weaken browser server-import checks. That app's full 515 tests pass.

The installed HTTP check subsequently caught a real SDK integration defect: the SDK adds
credential feature annotations, so a frozen identity object breaks requests. The transport
now uses a fixed provider returning fresh mutable `test`/`test` identities, never a provider
chain or inherited identity. A regression checks fresh/annotatable identities. The final
clean run above includes this fix; earlier green runs are not substituted for final evidence.

Final release log `/tmp/jawstack-phase6-final2-release.log`: created
`2026-11-02T01:17:17.128Z`, last written `2026-11-02T01:20:40.837Z`, SHA-256
`7a82adf13e162b99f61349747faacc447bbb89eb86dd04b0c431154aa64a287a`.
This approximately 204-second log window is not agent-effort measurement.
`/tmp/jawstack-phase6-final2-install.log` retains the known missing prebuild workspace
CLI-bin warning. Existing browser externalization/build timing and CDK feature-flag notices
remain nonblocking; zero findings above refers to package guard/doctor, not all tool notices.

All 49 selected files (core/AWS source/tests and the Content alias regression) match the final
clone. SHA-256 of their sorted `[path, fileSha256]` list:
`c5d44a29c5d8632e87a34f6068fe001584f6ce01edb8122c7e1a3f0758e260ba`.
Status/index/evidence edits after the gate are Markdown only, covered by format/link/diff
audits. No fresh full browser interaction suite ran; no UI behavior changed.

## Installed Public API and Native Transport

Packed the final clone under `/tmp/jawstack-phase6-final-packed/`:

- Core SHA-256: `44b8db639a802d11dce14b26a6b2fb5a3561dafc36d32c1eb99cfa153aff6bf9`.
- AWS SHA-256: `b406a01dc83b9afd69063958557eefd57a18c418295821b5519eee3abcf967b0`.

These are byte-identical to the tarballs installed from `/tmp/jawstack-phase6-packed/`
into `/tmp/jawstack-phase6-installed-smoke`. Fixture overrides select that packed core and
matching top-level SDK versions, not workspace source. Mechanically extracted the installed
Dynamo declaration and all three local recipe blocks into separate modules. A copied SDK
contract double imports the installed public AWS root, not application/protocol internals.

Strict TypeScript 5.9.3 NodeNext/exact-optional checking with `skipLibCheck: false` and no
source aliases passed. The workspace supplies only compiler/Node declarations. Emitted ESM
resolves actual installed `dist/local.js` and core `dist/index.js`.

The fixture starts a temporary server only on otherwise-free `127.0.0.1:4566`, uses the
actual SDK/native HTTP handler and checks signed `test` credentials/Host headers. The SDK
endpoint override to AWS is rejected before the native HTTP fixture sees any request.
Then 43 loopback requests verify metadata-before-binding, actual command/typed receipt
writes, wrong-queue rejection without requests, failure collection, authorized replay,
duplicate/forged recovery, one business effect and resolved generation 1. Closing disposes
the runtime/client and removes the temporary listener; port 4566 was confirmed free afterward.

This is a real-SDK HTTP fixture backed by the narrow transaction double, **not LocalStack,
SQS/Lambda integration or live service atomicity evidence**. Host and Lambda semantics have
shared unit coverage, but this turn did not run inside a real emulator Lambda. Phase 5's
local-table proof is not relabeled as new transport evidence.

Logs: `/tmp/jawstack-phase6-installed-{install,types,recipe}.log`. Final recipe log last
written `2026-11-02T01:21:35.521Z`, SHA-256
`17a9f141808fa0cb17fde6eccdb511eb406f5b30866bb82f8c92bf1f9aa23186`.

## Boundaries and Integrity

The local boundary intentionally supports dummy account `000000000000`, `us-east-1`, fixed
host/Lambda origins, bounded lowercase names, and unqualified exact Lambda ARNs. This is not
a generic endpoint override, FIFO/alternate-region profile, production auth or cloud deployer.
Routing/profile hashes are trusted configuration identity, not authentication secrets or
proof of identical executable code. Table ownership is checked at startup, not atomically
with every later transaction; do not reassign/reset the lab under active services. Raw
transport settings alone do not establish ownership of buckets/queues or grant permissions.

No collector topology, public provisioning API, shared lab package, binding-file emitter,
existing-table adoption or current consumer migration ships here. Provisioning must supply
the exact four ownership tags before using the new local factory. Actual Lambda environment,
queue retries/collector delivery, least-privilege IAM and full LocalStack scenarios remain
later gates. Existing legacy SQS marker behavior/defaults are unchanged.

The frozen counter reports core **6,294 -> 6,298 (+4)** and AWS runtime
**2,536 -> 3,082 (+546)** token-lines. Core adds two values; AWS root adds one value and one
type, plus `/local` adds three values and four named types. The new transport/configuration
surface and package bytes are real growth, not hidden behind the root export count.
No package or version was added. The new shipped recipe and multi-entry shared JS chunk
explain the additional package files; legacy root output remains supported.

AWS now declares already-resolved `@smithy/node-http-handler` 4.8.2 directly and moves Zod
4.4.3 from dev to production because the shipped parser uses it. All dependency snapshots
and resolved versions are preserved. Relative to the frozen packet, the only changed input
hash remains `pnpm-lock.yaml`, now
`f02122587adff88187d9422a8f150e91b566cac80113e2b767bbf3c61a409179`.
This extends Phase 5's disclosed dependency-input deviation; it is not an unchanged-lock
claim. Baseline evidence/inventory, task packets, PRD/TDD and compatibility JSON remain
unchanged. Both task packet `--check` commands pass; no new A/B session or refreeze occurred.

Selected consumer protocol remains **1,589 token-lines**, separate selected lab code
**1,552**. No retirement or agentic speed improvement is claimed before consumer migration
and post exercises. App runtime/CDK/template/CI source is untouched; only app source aliases
and their exact regression changed. Read-only probes confirm the 4337 memory/managed API
remains healthy and the review item remains version 3 / draft. No review runtime/data was
restarted or reset. No Docker/emulator was started, token file read, secret configured or
real AWS request made. Staged diff is empty.

Next: Phase 7 adds opt-in collector infrastructure and metadata-read grants. Shared owned
lab lifecycle, actual delivery, consumer migrations and leverage acceptance remain later work.
