# Framework Leverage Measurement Packet

Phase 0 freezes the before-state and prepares exercises. It does **not** implement the
two benchmark features, execute a fresh-agent comparison, or establish a productivity win.
The [implementation plan](../implementation-plan.md) gates Phase 1 on reviewed baseline
A/B observations, not simply this packet's existence.

## Frozen Baseline

`baseline.json` records the actual pre-extraction source commit, tracked-patch hash,
tool versions, packet/lock/design hashes, selected AST spans/subtree exclusions, source
hashes and token-line counts. `inventory.json` records the reviewed selection and counting
rules. Never change the denominator or re-freeze it to accommodate extraction results.

The selected denominator is **1,589 token-lines** in fourteen Content Operations files.
Its 50% gate permits at most 794 post-migration token-lines, including replacing thin
composition and retained/moved generic algorithms. The seven inventoried lab modules have
another **1,552 token-lines**, reported separately; deleting them cannot satisfy the
protocol metric. Type declarations/imports/punctuation inside selected spans count under
the same rule as other nontrivia TypeScript. A partially excluded line still counts if
any selected token remains, including a declaration keyword or terminator.

The inventory excludes application-owned authorization, publication reconciliation,
materialization and named domain record/target decisions. Its per-entry reasons explain
small configuration and hook invocation sites that still count. Uploads, object storage,
artifacts, notification implementation and recurring-job policy are not in the denominator.
The selected set and exclusions require user review before baseline exercises/extraction.

Framework snapshots disclose all maintained `packages/*/src` TypeScript source hashes/
token-lines, package export maps and declared index names/export statements. Those names
are a starting inventory, **not** a semantic concept count or a flattened star-export
analysis. Final review must account for new subpaths, reexports, adapter concepts and both
consumers' configuration/integration footprint rather than relying on that count alone.

```sh
pnpm leverage:measure verify
pnpm leverage:exercise --task a --check
pnpm leverage:exercise --task b --check
pnpm leverage:exercise --task compat
```

`verify` checks the frozen input bytes, selected AST hashes/counts, complete Content `src`
set and framework source/export snapshot. Run it **before** a baseline task modifies source.
It intentionally fails once extraction or an exercise changes those sources. Later
commits containing only Phase 0 tooling/docs may have a different HEAD from the original
source commit; the recorded runtime hashes establish which behavior is being compared.
The original tracked-patch hash is provenance, not a demand to revert documentation changes.

`--check` hashes the packet without running feature tests or starting services. Its
`exerciseExecuted: false` is intentional. Normal root `pnpm test` runs the tooling tests
and working compatibility golden test, **not** either unimplemented feature suite.
The `.acceptance.ts` task suites are selected only by the explicit runner. Missing candidate
adapters, unknown flags or changed frozen task fixtures fail nonzero before candidate tests.

## Compatibility Reference

`compatibility.json` was captured by running the existing implementations, using the
fixed, credential-free input in
`apps/content-operations/test/support/leverage-compatibility.ts`. It freezes resource/
activity/projection/outbox/scoped-idempotency/command-receipt transaction rows and conditions,
publication-attempt key/record, canonical wire bytes/fingerprints, failure record/key/view,
recovery envelope/outbox and worker/collector marker keys/expiry. These synthetic structural
fixtures are not a claim that the minimal command state is a complete editorial aggregate
or that a real AWS transaction was executed.

The explicit one-time `--task compat --capture` writes with create-only semantics; it
cannot overwrite an existing golden. Do not delete or recapture the golden after extraction.
Adapt the capture/test adapter to the new public implementations while preserving expected
bytes/rows. Existing domain and live suites still provide behavioral evidence beyond this
structural sample. Record any genuinely required compatibility change for explicit review.

## Baseline Session Setup

After reviewing and committing Phase 0 yourself, create **two** disposable detached
worktrees from that same Phase 0 commit. The agent does not commit or start another agent.
For example, replace `PHASE0_COMMIT` with your reviewed commit hash:

```sh
git worktree add --detach ../jawstack-leverage-baseline-a PHASE0_COMMIT
git worktree add --detach ../jawstack-leverage-baseline-b PHASE0_COMMIT
```

Before each task, activate `.nvmrc`, install with `pnpm install --frozen-lockfile`, run
`pnpm leverage:measure verify` and record HEAD/packet identity. A clone/copy is also valid
if it contains the reviewed packet and identical runtime bytes. Do not copy ignored env
files, manifests, installed modules, `dist` or the interactive review dataset. Checkouts
must be independent: no feature patch or dirty source shared between A and B.

Agree and record the visible client version, model label, reasoning setting and available
tools **before baseline A**. Exact settings are not exposed to the Phase 0 agent and are
not invented in `baseline.json`. Use the same visible settings for all four sessions where
possible; disclose any change. Packet defaults are thirty minutes active elapsed, at most
five minutes excluded install waits, and no service waits because these neutral suites use
memory/SDK doubles. Full application verification time counts as active, not an excluded
wait. Any optional live expansion/budget change requires a recorded decision before either
member of a pair, not a silent extension after seeing the result.

Open a fresh session in each worktree with only the task handoff, not this conversation or
the opposite solution. A suitable handoff, replacing A/B as appropriate, is:

> Implement Task A from docs/iterations/003-framework-leverage/leverage/task-a.md in this
> disposable checkout. Follow the packet's budget and record visible settings/start/end,
> waits, edits and verification. Do not implement another iteration phase, edit the neutral
> task/fixture/runner, commit/push, or start paid services/another agent. Use the real app
> and supported public APIs; report partial or failed work honestly.

Both tasks require a thin test adapter per `contracts.ts`/`candidate.d.ts`; it must delegate
to real changed application paths/stores, not cache expected values or recreate the feature
inside tests. Review adapter code as part of functional equivalence. Record test-adapter
setup separately from domain edits and generic integration churn, including documentation
lookup, private-source understanding, failed tests and correction rounds.

The runner invokes a bounded single-worker Vitest process against actual app services and
the narrow SDK doubles; it emits start/end/commit/outcome events, not an entire agent-session
timer. The supervisor/client must capture session start/end and install wait intervals.
No token, exact-model or hidden thinking-time telemetry is inferred from subprocess duration.

## Recording Actual Observations

Raw patches/logs/timing belong under `raw/` (Git/Prettier ignored), never in public artifacts.
Keep failed/partial attempts. Do not store tokens, env files, manifests or private model
reasoning. A session record for `pnpm leverage:measure session raw-path.json` has:

```json
{
  "schemaVersion": 1,
  "snapshot": "baseline",
  "task": "a",
  "result": "partial",
  "sourceCommit": "actual-checkout-commit",
  "modelLabel": "actual-visible-model-label",
  "reasoningSetting": "actual-setting-or-unavailable",
  "clientVersion": "actual-client-version-or-unavailable",
  "tools": ["actual-tools"],
  "startedAt": "actual-UTC-session-start",
  "endedAt": "actual-UTC-session-end",
  "waits": [],
  "tokens": null,
  "verification": [],
  "correctionRounds": 0,
  "changedFiles": [],
  "genericIntegrationChanges": [],
  "privateFrameworkUnderstanding": [],
  "confounders": []
}
```

This illustrates the schema, not an observation file. Each actual install wait has
`kind: "install"`, `startedAt` and `endedAt`. The summarizer validates intervals, unions
overlaps before subtracting them, reports budget overruns, keeps failed attempts and labels
tokens unavailable when null. Add actual verification commands/results, patch hash, file/
symbol classifications and correction evidence. The counter cannot independently audit
whether manual classifications or client timestamps are truthful; user review is required.

Sanitize real records into reviewed results only after the sessions occur. Do not create
empty results or substitute this session's experienced agent for a fresh observation.
Review both baseline results/settings/task equivalence before authorizing Phase 1. If a
pair is not comparable, record why and review measurement scope; do not erase the attempt.

## Post Sessions and Final Accounting

After Phase 13, freeze the reviewed functional candidate and public recipes. Create two
fresh candidate worktrees, apply the **same** task packets, use fresh sessions and record
the same observations. Never provide baseline solution patches. Post work must need no
framework-internal edits or new extracted protocol implementations. Changed candidate
runtime/API/profile code invalidates affected gates/exercise evidence.

Create a separate reviewed post-inventory specification, never modify `inventory.json` or
`baseline.json`. Reuse the exact frozen `rules` and classify all remaining generic work plus
thin replacement composition across the consumer, including generated/moved/renamed paths.
The tool accepts explicit app runtime paths beyond the old `src` filenames; reviewers must
also inspect new runtime extensions/directories, scripts and possible app-to-app copies.
Set `audit.reviewed` and `audit.allConsumerPathsReviewed` only after that review, with
reviewer/date/reasons. Those declarations are not automatically discovered proof.

```sh
pnpm --silent leverage:measure snapshot --spec POST_INVENTORY.json
pnpm leverage:measure compare docs/iterations/003-framework-leverage/leverage/baseline.json POST_SNAPSHOT.json
```

Save the generated post snapshot as the second command's input. Comparison rejects changed
rules, invalid counts or missing whole-consumer review, and reports the 50% structural gate
without declaring a leverage win. The final audit must disclose framework/API growth,
functional evidence, paired generic integration changes, timing/token limitations and
sample-size/familiarity/hardware/network confounders. A negative/inconclusive outcome is a
no-go for the accelerator claim, not permission for unlimited retries or weaker assertions.
