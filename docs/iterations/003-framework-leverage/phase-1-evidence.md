# Phase 1 Evidence: Typed Records and Logical Commit Plans

Status: complete, uncommitted for user review. The final clean release gate passed after
incremental JSON byte-budget hardening. The baseline prerequisite was reviewed
before framework edits; see [baseline review](baseline-review.md). Phases 2-14 and post
A/B have not started. No stage/commit/push, version bump, publication or deployment occurred.

## Delivered

- `packages/core/src/workflow/records.ts`: strict typed object-record definitions,
  registered identity, opaque detached creates, schema/JSON/key validation and matching
  root ownership. Forged/unregistered values, duplicate collections and reserved metadata
  reject. Native rejected Promise hooks are observed and rejected rather than left unhandled.
- `workflow/keys.ts`: pure partition/sort identities preserving existing resource/activity/
  outbox/projection/scoped-idempotency and `OPS` formats, including exact sort suffixes.
- `workflow/commit-plan.ts`: successful core-commit/scope/version/actor/time/source/response
  validation, frozen contribution inputs, projection coalescing and immutable create/
  version/expiry conditions. It preserves event order and the original potentially long
  core fingerprint, without implementing another command engine.
- `workflow/validation.ts`: shared finite-JSON/UTF-8/work bounds. A coalesced replacement
  put cannot bypass per-record limits. No SDK client/shape, store or timer is constructed.
- Supported root exports and the minimal `WorkflowCommitStore` adapter type. A planner's
  `validate` accepts only its own immutable plans, not clones, casts or another producer's
  output. No raw transaction/action constructor or public HTTP write route is provided.
- [Core documentation](../../../packages/core/README.md#atomic-record-definitions) for
  the working pure APIs and adapter responsibilities, not an unfinished runtime factory.

No `createMemoryWorkflow`, `createDynamoWorkflow`, SDK compiler or storage implementation
is exported as a placeholder. Actual condition checking/atomic publication belongs to
later memory/Dynamo phases. This phase supplies plans and required conditions; its tests
do not claim the future adapters already reject existing stored keys. Legacy behavior
and default infrastructure remain unchanged.

## Contract Details

Contribution invocation is `{ scope: { resourceType, commandName, subject }, now }`, using
the captured canonical UTC ISO instant. The hook sees a detached recursively frozen core
commit, not ingress contexts or runtime clients. Runtime composition supplies that scope;
the planner does not authenticate callers. Key/owner/contribution functions must be pure;
the contract cannot sandbox effects captured by trusted application closures.

Record schemas must be Zod object schemas and are made strict. Normalized JSON is
revalidated; non-idempotent transforms reject. Definitions/creates/plans are process-local
opaque identities, not serialized authorization tokens. Tenant metadata and command-
authored recovery delivery metadata are unsupported. Schemas validate without reordering
the detached original event values or changing core fingerprint encoding.

Explicit TTL is positive and at most seven days; both planned consumers select seven.
Scope/idempotency components use the bounded ASCII alphabet. Record keys allow valid
UTF-8 through 1,024 bytes. Bounds are 60 normalized actions, 192 KiB per logical action,
64 KiB per auxiliary action including key/owner metadata, 1 MiB aggregate plan, depth 16
and 10,000 nodes. Input admission also bounds pre-normalization work. Service compilers
must still check encoded request limits; legacy APIs do not acquire these opt-in rules.

## Verification

Focused checks passed before the full gate:

- **42 new core tests**: typing/registration/ownership, forged definitions/creates/plans,
  async/mutating hooks, immutable copies, keys/conditions, event/fingerprint preservation,
  coalescing/moves/collisions, invalid JSON/metadata, 60/61 actions and all work budgets.
- **Three new Content compatibility tests**: unchanged frozen golden rows/keys/event bytes;
  actual create/submit/approve/publish/claim/complete commits fit in both current memory
  and narrow DynamoDB test adapters, including publication-attempt records/projections.
  Existing adapters still write; the test does not migrate storage or prove live DynamoDB.
- Core and Content typecheck/lint passed. Development typecheck caught Zod optional-field
  typing versus exact optional core types; validated detached input is narrowed without
  reordering values. No existing schema/assertion was weakened.

A fresh clone `/tmp/jawstack-iteration3-phase1-final` overlays the reviewable source
on HEAD `3e11f152113cafe5411dbe5a2d112821047b7538`, excluding ignored dependencies,
outputs, tokens, manifests, benchmark raw data and review data. Ran
`pnpm install --frozen-lockfile`, then `pnpm verify:release`, **tests before package builds**.

| Gate                         | Actual result                                                                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean frozen install/release | Passed on Node 24.16.0 / pnpm 10.21.0, without a preparatory build.                                                                                             |
| Workspace tests              | 851 passed: core 153, AWS runtime 76, CDK 36, Angular 42, CLI 20, generator 7, Work Requests 2, Content 515.                                                    |
| Tooling/compatibility        | Eleven Node tests and one existing golden test passed; total release test count 863.                                                                            |
| Typecheck/lint/format/build  | Passed in the clean clone.                                                                                                                                      |
| Browser boundaries           | Angular package and consumer build checks passed; package report retained 329 modules and zero server imports.                                                  |
| Package guard                | Zero errors, warnings or info.                                                                                                                                  |
| Generated app                | Install/lint/typecheck/tests, browser and AWS builds, synth and doctor passed; doctor had no findings.                                                          |
| Package dry runs             | All six passed; core unpacked size 130,829 bytes versus prior 102,641. Nothing published.                                                                       |
| Compiled API smoke           | Built core JS and its installed Zod successfully define/create a record, produce/validate a plan, reject a cloned plan and return frozen data; no source alias. |

Final release log `/tmp/jawstack-phase1-final-release.log`: created
`2026-11-01T21:49:57.379Z`, last written `2026-11-01T21:53:11.158Z`, SHA-256
`ffad8a0b8764ad7f9e8c9cc448c45af8bc1176cf0bd6aff1595416a6dd4d3247`.
These are log timestamps, not agent-effort measurements. Install log
`/tmp/jawstack-phase1-final-install.log` retains the known prebuild workspace CLI-bin warning;
no Node engine workaround or prebuild hid it.

The earlier clean release also passed and remains at `/tmp/jawstack-phase1-release.log`.
Final review then strengthened byte accounting to stop oversized trees before full-tree
serialization and added its regression test; the complete clean gate above was rerun,
not inferred from the earlier source. Final compiled smoke additionally checked that
all built core source inputs match the actual review checkout.

Final status/evidence/index edits after that gate are Markdown/JSON only; current format/
link/diff checks cover them. No fresh full Content browser or live LocalStack suite ran
in Phase 1. Earlier evidence is not relabeled a fresh pass; storage, live delivery and
migration acceptance remain later gates.

Final working-tree documentation audit passed: 54 Markdown files, 223 local links,
35 anchors and zero broken targets. Formatting and `git diff --check` passed; the staged
diff is empty. The frozen input hash audit still has zero mismatches.

## Growth and Integrity

The frozen counter reports core growth from **2,601 to 3,311 token-lines**, **+710**
including types/exports. The new root surface has four value exports and twelve named
types; those values also introduce record `create`, planner `plan`/`validate` and six key
helpers. This is real adapter/concept burden, not hidden behind an unchanged package count.

Selected consumer protocol code remains **1,589 token-lines**: no retirement is claimed
before migration. Frozen input bytes, baseline/task files and denominator are unchanged.
The frozen-source verifier now intentionally rejects the changed core source/export set
on main; do not refreeze to make it green. Benchmark implementations/raw records remain
untouched in their separate worktrees and are not shipping features.

Main app runtime, AWS runtime/CDK source, lockfile and versions are unchanged. Read-only
checks confirm the 4337 review API remains `memory` / `managed`, with content
`10000000-0000-4000-8000-000000000002` still version 3 / draft. No review process/data
was restarted/reset, env/token read, Docker/lab started, real AWS used, remote workflow
dispatched or secret configured.

Next: Phase 2 composes the existing executor with scoped invocation and memory atomic
storage using these plans. No new public runtime factory is implied by Phase 1 completion.
