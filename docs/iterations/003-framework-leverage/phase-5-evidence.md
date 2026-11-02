# Phase 5 Evidence: DynamoDB Workflow Storage

Status: complete, uncommitted for user review. Review base:
`930f5efcbd7fd130840708d1020d89702022f683`. No staging, commit, push, version bump,
publication, remote workflow dispatch or real AWS deployment occurred.

## Delivered

- Public `createDynamoWorkflow(definition, { client, tableName, bind, ...options })` uses
  core's existing executor, planner, recovery protocol and delivery ordering. It exposes
  complete services, not a memory store/pump or arbitrary SDK write hook. Construction
  performs no I/O, client creation or timer startup; close never destroys a borrowed client.
- The compiler validates provenance through its bound planner and maps only known plan
  actions through existing item encoders. State/version conditions, create-only activity/
  outbox/auxiliary writes, exact projection movement and absent-or-expired idempotency
  share one transaction. Recovery CAS/history/projection/replay outbox also share one.
- The narrower 60-action budget, conservative encoded item/request limits, duplicate
  physical-key checks and observed projection-delete sizes reject before writes. Stable
  request tokens support identical SDK retries; they do not replace command idempotency.
  Existing SDK/service limits remain authoritative under concurrent external changes.
- Strong point reads validate storage keys/kinds, finite bounded JSON and supported
  fields before removing metadata, serving cached values, applying logical expiry or
  overwriting replaceable rows. Invalid state is not converted to absence/unavailability.
  Ordered complete known cancellation reasons classify scoped idempotency versus other
  conditional failures; ambiguous/unknown outcomes retain sanitized unavailable errors.
- `WorkflowStorageSpec.validation` supplies shared resource/idempotency/activity/projection/
  record validators and JSON bounds through supported core exports. Flat auxiliary reads
  derive registered keys/owners without adding hidden fields that collide with business
  schemas. No private core or application runtime imports were introduced in AWS runtime.
- Existing state/activity/outbox/projection/idempotency builders and legacy defaults are
  unchanged. Frozen command rows, original/replay wire bytes, failure projection/history
  and marker formats pass compatibility checks. Content Operations has no new active writer.
- A shipped [DynamoDB recipe](../../../packages/aws-runtime/workflows.md) demonstrates a
  complete public declaration/binding with an application-owned retry-safe rendering port.
  The [core adapter recipe](../../../packages/core/workflows.md#adapter-authors) documents
  the validation extension. AWS runtime now includes its recipe in package files.

## Boundaries

This proves storage and shared public services, not stream dispatch, real SQS batch/origin
validation, collector redrive, full local delivery or application migration. Those remain
later gates. No public `/local` factory or placeholder SQS API is exported this phase.

Durable markers intentionally retain the legacy event-ID-only shape. They cannot detect
a different ordinary fact reusing an already-processed transport ID, unlike memory's
additional process-local fingerprint check. Recorded recovery is still authenticated
against exact durable history before any marker read, including duplicates/ignored fanout.
The parity matrix does not claim otherwise. Markers are not distributed locks or exactly-once
effects; immutable business identity, version/fence conditions and safe effects remain
application obligations. Concurrent handlers may enter before either writes a marker.

A local client/table guard rejects differing manifest hashes, permits matching API/worker
composition, and releases failed-construction reservations. It is not physical table
ownership verification or proof of equivalent callback/schema code. Explicit dedicated-table,
deployment ownership and IAM discipline remain required across clients/processes. Preflight
reads validate corruption/size; transaction conditions still arbitrate concurrent writers.

## Clean Verification

Final source was overlaid into a fresh clone at
`/tmp/jawstack-iteration3-phase5-final-verification`, excluding ignored dependencies,
build outputs, token files, manifests, benchmark raw data and interactive review data.
Ran `pnpm install --frozen-lockfile` then `pnpm verify:release`, tests before package builds,
on Node 24.16.0 / pnpm 10.21.0. No preparatory build masked resolution defects.

| Gate                        | Actual result                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace tests             | 1,113 passed: core 345, AWS runtime 144, CDK 36, Angular 44, CLI 20, generator 7, Work Requests 2, Content 515.                                                                                                                 |
| Tooling/compatibility       | Eleven Node tests and one frozen golden test passed: 1,125 primary release tests, excluding the generated fixture's separate two tests.                                                                                         |
| New regressions             | 68 AWS tests plus one core validator test; shared memory/Dynamo contracts, compiler provenance/bounds, concurrent expiry/CAS, rollback, corruption, uncertain/late winners, completion/marker failures and no-I/O construction. |
| Typecheck/lint/format/build | Passed in the clean clone.                                                                                                                                                                                                      |
| Browser boundaries          | Existing source/flattened resource-only constructor regressions and Angular/consumer boundary checks passed; Angular report: 329 modules, zero server imports.                                                                  |
| Package guard               | Zero errors, warnings or info; no new suppression.                                                                                                                                                                              |
| Generated app               | Install/lint/typecheck/two tests, browser/AWS builds, synth and doctor passed; doctor had no findings.                                                                                                                          |
| Package dry runs            | All six passed. Core: six files / 253,407 bytes unpacked; AWS runtime: six files / 99,502 bytes, including its recipe.                                                                                                          |

Final release log: `/tmp/jawstack-phase5-final-release.log`, created
`2026-11-02T00:43:32.255Z`, last written `2026-11-02T00:46:50.193Z`, SHA-256
`1918feab6d0d4e2c4de951fe47f9b39666d10b5209257b328eeb09744dcee4d1`.
These are log timestamps, not agent-effort measurements. The initial clean release passed
too, but is not substituted for this final run after the delete-size regression was added.

The frozen install log `/tmp/jawstack-phase5-final-install.log` retains the known missing
prebuild workspace CLI-bin warning. Existing browser externalization/build-timing and CDK
feature-flag notices remain nonblocking; zero findings above means package guard/doctor,
not a claim that every tool printed no notices.

All 42 selected files (core/AWS source/tests and the probe) match the final clone.
SHA-256 of their sorted `[path, fileSha256]` list:
`64984b507e0010c11e975dd5f69fb5bf73573b76bcc84bbbade75fc022963016`.
Final status/evidence/index changes are Markdown only, covered by formatting/link/diff
audits. No fresh full Content browser suite ran; no UI behavior changed.

## Owned Local Table Probe

[The table-only probe](../../../apps/content-operations/scripts/probe-workflow-storage.ts)
uses public workflow imports and existing app lab tooling only for setup/safety. Runtime
packages never import that tooling. Reproduction from an otherwise available local Docker
environment with the existing ignored Hobby settings:

```sh
CONTENT_OPS_LAB_ID=wf5-a930f5ef pnpm --filter content-operations local:up
CONTENT_OPS_LAB_ID=wf5-a930f5ef pnpm --filter content-operations exec tsx scripts/probe-workflow-storage.ts
CONTENT_OPS_LAB_ID=wf5-a930f5ef pnpm --filter content-operations local:down
```

The runner refuses non-`wf5-*` IDs, checks the exact manifest/container owner and pinned
image, rejects inherited AWS settings, uses dummy credentials and validates the final
loopback destination. It creates a unique tagged PK/SK-only table, verifies ownership
before mutations/deletion, uses finite waits, and deletes only the table it created.
It does not provision application resources, enable TTL/streams or reset any dataset.

The final actual run used `http://127.0.0.1:4566`, project
`jawstack-content-ops-wf5-a930f5ef`, table
`jawstack-content-ops-wf5-a930f5ef-wf5-95416b4f`, arm64 LocalStack
`2026.10.0@sha256:aa5632e041ca54ff61a0a25e17b1c898b09a1eb7f611bfc05f73ef53b7266872`,
Hobby (existing user attestation). It passed:

- An auxiliary-only collision leaves **every transaction target** unchanged, including
  primary state, activity, outbox, projection and edit idempotency; no partial publication.
- A physically retained expired idempotency row is replaced conditionally at seven days,
  without TTL deletion or a separate delete/write sequence.
- An intentionally lost successful transaction response converges through strong replay
  with identical response metadata and no extra decision/transaction. Three transaction
  attempts and three decisions total; 25 instrumented strong workflow reads, plus direct
  setup/rollback/ownership checks.

The table deletion was confirmed, then the owned emulator/network were removed. Final
cleanup reports zero emulator/Lambda containers and zero networks; images are retained.
Logs: `/tmp/jawstack-phase5-local-{up,probe,down}.log`. Final probe last written
`2026-11-02T00:44:21.429Z`, SHA-256
`a60af1f494ad9cf93d4a15b08231fdd09daed326df9597eff607c80ad23889a3`.
The existing ignored token was loaded by lab lifecycle tooling but never displayed,
copied to the clone, or included in evidence. No real AWS call occurred.

## Installed Recipe

Packed the final clone into `/tmp/jawstack-phase5-packed/`:

- Core tarball SHA-256: `dafe9ac91f46f9b07e20a647fc1fb75099eb4707cf7befd7ee9969746231d010`.
- AWS runtime tarball SHA-256: `ffdec3d1eb17ff379b33a9699493d4f40a99faa152a83e5d1e385ee8def124ff`.

Installed both tarballs, Zod 4.4.3 and matching DynamoDB SDK versions in
`/tmp/jawstack-phase5-installed-smoke` with `pnpm install --ignore-scripts --prefer-offline`.
Fixture overrides select the packed core and matching SDK versions, not workspace source.
Mechanically extracted the first TypeScript block from the **installed** AWS `workflows.md`.
A copied narrow SDK contract double changes only its import to the installed public AWS
entry point; it contains no executor/recovery algorithm and is not live-service evidence.

Strict TypeScript 5.9.3 NodeNext checking with `skipLibCheck: false`, exact optional fields
and no source aliases passed. The workspace supplies only compiler/Node declarations.
Executed the emitted ESM and verified installed `dist/index.js` resolution for both packages,
zero startup requests, actual command/projection/typed receipt writes, a lost commit response,
collection, request-deduplicated replay, one rendering effect, and resolved generation 1.
Logs: `/tmp/jawstack-phase5-installed-{install,types,recipe}.log`. This is narrow independent
public storage/API proof, not the installed Report Runs or full transport gates of Phase 13.

## Growth and Integrity

The frozen counter reports core **6,227 -> 6,294 token-lines (+67)** and AWS runtime
**1,916 -> 2,536 (+620)** this phase. The root adds one value (`createDynamoWorkflow`) and
one named type (`DynamoWorkflowOptions`); the existing adapter contract also gains six
validator members. Internal compiler/store helpers are not additional root exports.
No new package, export-map subpath or production dependency was added. AWS's shipped
recipe increases package contents; existing versions remain unchanged.

AWS tests now declare the already-resolved Zod 4.4.3 as a development dependency. The only
frozen input hash that differs is therefore `pnpm-lock.yaml`: an AWS importer development
dependency entry, with no resolved package-version changes. Frozen lock hash:
`4abe7989e75ce4cc1cf6fa4c970059025929a1472823abb7a4ae2a0dbe23dd22`;
current: `f2c193c9fe3a1d572a3249c26e65f2020b9f0d0fddf950ad7ab26f203c7cf74b`.
This is a disclosed environment-input deviation for later paired measurements, not an
unchanged-lock claim or permission to refreeze baseline evidence. PRD/TDD/task packets,
compatibility JSON, inventory and baseline results remain unchanged. Both A/B packet
`--check` commands pass; no new exercise session was executed.

Selected consumer protocol remains **1,589 token-lines**, separate selected lab code
**1,552**. The new 382-physical-line table-probe script is verification tooling outside
those frozen selections; it is disclosed, not counted as framework leverage or retirement.
No migration or measured agentic improvement is claimed yet. Application/CDK/UI runtime
source is untouched. Read-only probes confirmed the existing 4337 memory/managed API is
healthy and the review item remains version 3 / draft. No interactive runtime/data was
restarted or reset. Staged diff is empty.

Next: Phase 6 supplies strict SQS bindings and the guarded public local runtime. Full
transport delivery, migrations, Report Runs and post-extraction leverage remain later gates.
