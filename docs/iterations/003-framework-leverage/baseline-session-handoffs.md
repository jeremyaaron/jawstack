# Baseline Session Preparation

Status: historical preparation record. Both worktrees were prepared November 1, 2026;
the exercises have since run and their [baseline review](baseline-review.md) clears the
Phase 1 prerequisite. Retain the instructions below as the actual handoff, not a request
to rerun attempts for better timing. No benchmark feature is shipped in the main app.

The user selected preparation of two fresh-session baseline runs rather than deferring
the measurement gate. No agent was spawned and no benchmark feature was implemented.

## Prepared Checkouts

| Exercise                           | Worktree                          | Local handoff, relative to that worktree                                    |
| ---------------------------------- | --------------------------------- | --------------------------------------------------------------------------- |
| A: Atomic approval receipt         | `../jawstack-leverage-baseline-a` | `docs/iterations/003-framework-leverage/leverage/raw/baseline-a-handoff.md` |
| B: Recoverable publication receipt | `../jawstack-leverage-baseline-b` | `docs/iterations/003-framework-leverage/leverage/raw/baseline-b-handoff.md` |

Paths above are relative to the main `jawstack` checkout under
`/Users/jeremyaaron/Projects`. Both are detached at the user-committed Phase 0 source
`3e11f152113cafe5411dbe5a2d112821047b7538`; neither creates a branch. Their underlying
pre-extraction runtime matches frozen source `ae3268551bdda01592c6bdc08a76954e6eb1e02e`.
The tracked source trees are initially clean. The local handoffs are ignored under `raw/`,
not changes to the immutable task specification, fixtures or source baseline.

## Preparation Checks

Completed independently in **both** worktrees, using `.nvmrc` Node 24.16.0 and pnpm 10.21.0:

- `pnpm install --frozen-lockfile`: passed, with separate installed dependency trees.
- `pnpm leverage:measure verify`: passed, including frozen source/packet/span/export checks.
- `pnpm leverage:exercise --task a --check` or `--task b --check`: passed readiness only;
  each reports `exerciseExecuted: false`.
- `pnpm test:tooling`: eleven Node tests and the compatibility golden test passed.
- `pnpm typecheck:tooling`: passed.
- `git status --short`: clean. `git check-ignore` confirms each local handoff is ignored.

No prebuild was performed, no env/token/ownership manifest/review data copied, and no
Docker, AWS or application server started. The known fresh-install workspace CLI-bin
warning occurs before `dist/cli.js` exists; do not fix it by silently introducing a
prebuild. It does not prevent the checks above. Local preparation logs are
`/tmp/jawstack-baseline-a-bootstrap.log` and `/tmp/jawstack-baseline-b-bootstrap.log`.

This coordinator setup is outside the fresh exercise timer. Record that fact as a setup
condition and prepare equivalent dependencies for the eventual post sessions. Do not
report these tooling checks as passing benchmark acceptance or as agent-effort evidence.

## Start the Sessions

Run **A, then B**, in separate fresh conversations rooted in the corresponding worktree.
Avoid concurrent runs and their machine-contention confounder. Do not continue this
coordinator conversation as a benchmark session or share either solution with the other.

Before coding, agree and record the actual visible model label, reasoning setting,
client version and available tools. Use the same settings for both baseline and later
post sessions where practical; record deviations rather than inventing hidden identifiers.
The handoffs require the fresh agent to ask if those settings are not visible/provided.

For Task A, open the `jawstack-leverage-baseline-a` worktree and send:

> Read docs/iterations/003-framework-leverage/leverage/raw/baseline-a-handoff.md and carry
> out only that baseline exercise. Confirm visible model/settings before coding; follow
> its timing, verification, result-recording and no-commit rules. Do not run Phase 1 or
> inspect another worktree's solution. This is a fresh baseline observation, not production
> implementation.

For Task B, open the `jawstack-leverage-baseline-b` worktree in a different fresh session:

> Read docs/iterations/003-framework-leverage/leverage/raw/baseline-b-handoff.md and carry
> out only that baseline exercise. Use the same user-agreed visible model/settings as A;
> follow its timing, verification, result-recording and no-commit rules. Do not run Phase 1
> or inspect A's worktree/solution. This is an independent baseline observation.

Each has a thirty-minute active elapsed budget plus at most five minutes separately
recorded install waits, with no service waits. Ordinary tests/tools count as active.
Missing prerequisites, interruptions, failed/partial attempts and budget overruns must
remain visible. No automatic agents, paid API, cloud fallback or unlimited retries.

## Bring Back Actual Results

Each fresh session should leave its feature diff, including new untracked files, and its
real session record in that worktree's ignored `raw/` directory:

- A: `docs/iterations/003-framework-leverage/leverage/raw/baseline-a-session.json`.
- B: `docs/iterations/003-framework-leverage/leverage/raw/baseline-b-session.json`.

These record files were **not** created by preparation; the fresh agents subsequently
produced them. The handoffs specify the
required settings, timing/waits, verification, correction rounds, changed files, patch
identity, domain/generic integration work and test-adapter overhead. Keep raw logs and
patches local; no tokens, manifests, env files or private reasoning. No stage/commit/push.

Return to this coordinator with both result locations and outcomes. Review task equivalence,
settings and actual evidence before authorizing Phase 1. Preserve both worktrees until
review; do not reset or remove partial/failed attempts. See the
[measurement packet](leverage/README.md) and [Phase 0 evidence](phase-0-evidence.md) for
the frozen baseline and acceptance boundaries.
