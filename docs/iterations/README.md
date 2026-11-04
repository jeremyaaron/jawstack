# Development Iterations

JawStack evolves through useful consumer applications and focused framework improvements.
An iteration is a bounded development objective, not a package version or a commitment to
release the framework.

## Index

| Iteration                                                   | Status               | Outcome                                                                                                                                          |
| ----------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [001: Foundation](001-foundation/README.md)                 | Archived baseline    | Merged and tagged `v0.0.1` in Git; npm publication and `0.1.0` deferred.                                                                         |
| [002: Content Operations](002-content-operations/README.md) | Complete             | Maintained editorial consumer, additive framework contracts, memory/browser and owned Hobby acceptance; see its outcome report.                  |
| [003: Framework Leverage](003-framework-leverage/README.md) | Phases 0-12 complete | Public command/delivery/recovery composition, migrated Content and independent Report verified; installed/fault and final leverage gates remain. |

## Planning Flow

Each iteration has its own directory containing:

1. `prd.md`: users, outcomes, scope, ownership boundaries, non-goals, and acceptance criteria.
2. `technical-design.md`: concrete contracts, architectural decisions, tradeoffs, and verification strategy.
3. `implementation-plan.md`: phases sized for one code -> user review -> user commit cycle.

Create each artifact when its preceding document is ready for review. Do not create empty
design or implementation-plan placeholders. Implementation does not imply permission to
commit, push, tag, or merge.

Plans should distinguish consumer work, framework work, and shared tooling. Start with
existing public APIs; improve the framework when a concrete requirement reveals a defect
or missing reusable contract. Application-specific behavior can remain application code.
Do not build a module ecosystem in anticipation of hypothetical consumers.

Keep each phase buildable and testable. Split phases whose diffs cross too many ownership
boundaries to review coherently. Record scope changes and verification evidence as work
progresses, including checks not performed and known limitations.

## Repository Ownership

- `apps/`: private, maintained first-party reference applications with their own READMEs.
- `packages/`: reusable framework packages and their supported public APIs.
- `templates/`: generated-app starters, updated when shared contracts require it.
- `scripts/` and shared configuration: repository development and verification tooling.
- `docs/`: current product documentation, iteration records, and internal research.

Reference applications consume package exports, not other applications' source or package
internals. Workspace development gives fast feedback; isolated generated-app and package
verification checks that workspace resolution has not hidden packaging problems.

An experiment does not automatically become a maintained reference application. Keep it
only if it demonstrates a useful capability and has a clear verification path; otherwise
remove it after documenting the result. Maintain the existing Work Requests consumer when
introducing another reference application.

## Documentation Lifecycle

Top-level [product documentation](../README.md) and package/application READMEs describe
implemented behavior. New plans must not be presented as shipped features.

Iteration documents record the scope and design of their own effort. Once completed, retain
them as historical records with an outcome summary and links to current documentation.
Do not extend an old phase list indefinitely or silently rewrite its original intent to
include later work. Early speculative research remains in [internal notes](../internal/README.md).

## Release Decisions

Finishing an iteration does not require a framework release. Consumer-only changes can be
merged without changing public package versions. A framework fix, capability, or supported
developer-tooling improvement may justify a release with its own verification and notes.

For now, public JawStack packages use coordinated versions when a release is deliberately
prepared. Private applications do not have to share that version. Assess release readiness
from the actual changes and evidence, not the iteration number. Publication, tagging, and
release automation require an explicit release decision; Iteration 2 is not automatically
`v0.0.2`.
