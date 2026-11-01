# Iteration 3: Framework Leverage

Status: Phases 0-1 and the reviewed baseline A/B gate are complete. Phases 2-14 remain planned.
Baseline timings have explicit qualifications; post-extraction leverage is not yet established.

## Documents

- [PRD](prd.md)
- [Technical Design](technical-design.md)
- [Implementation Plan](implementation-plan.md)
- [Measurement Packet and Session Handoff](leverage/README.md)
- [Phase 0 Evidence](phase-0-evidence.md)
- [Prepared Baseline Worktrees and Fresh-Session Handoffs](baseline-session-handoffs.md)
- [Baseline Exercise Review](baseline-review.md)
- [Phase 1 Evidence](phase-1-evidence.md)

## Intended Outcome

Make supported AWS/TypeScript application work materially easier for coding agents by
productizing two protocols already exercised in Content Operations: invocation-scoped
command persistence and durable worker failure/recovery operations.

Refactor Content Operations to consume those public contracts, then prove their reuse in
a small independent, headless Report Runs consumer. Share the minimum local runtime/lab
composition needed by both; do not create another app-owned infrastructure platform.

Acceptance includes preserved behavior, actual memory/LocalStack evidence, an isolated
installed consumer, a reduction in consumer-owned protocol code, and paired before/after
agent change exercises. Moving files into a package is not sufficient evidence of leverage.

Editorial rules, publication fences/artifact semantics, uploads, recurring-job policy,
production authentication, real-AWS deployment, and publication remain outside this
iteration's extraction scope. See the PRD for the precise boundaries.

This iteration follows the [development process](../README.md). The plan contains 15
implementation phases plus four separately coordinated fresh-session change exercises.
The agent implements; the user reviews and commits. The iteration number does not imply
a package version or release authorization.
