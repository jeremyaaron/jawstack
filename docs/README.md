# JawStack Docs

## Product Documentation

These pages describe the supported product and should evolve with the implementation.
They are distinct from the design intent recorded in iteration plans.

- [Quickstart](quickstart.md)
- [Deploy To AWS](deploy-to-aws.md)
- [Destroy Your Stack](destroy-your-stack.md)
- [Architecture Overview](architecture-overview.md)
- [Application Composition](application-composition.md)
- [Resource](resource.md)
- [Command](command.md)
- [Event](event.md)
- [Worker](worker.md)
- [Schedule](schedule.md)
- [Cost Profile](cost-profile.md)
- [Release Checklist](release-checklist.md)

## Reference Applications

- [Work Requests](../apps/demo-work-requests/README.md): original starter and generated-app baseline.
- [Content Operations](../apps/content-operations/README.md): seeded memory walkthrough,
  explicit Hobby lab, architecture/service matrix, verification, and recovery.
- [Content Workbench](../apps/content-operations/WORKBENCH.md): five views and browser/CI acceptance.

## Development Iterations

Each iteration follows PRD -> technical design -> implementation plan. Iteration numbers
are planning identifiers, not framework versions.

- [Iteration Process and Index](iterations/README.md)
- [Iteration 1: Foundation](iterations/001-foundation/README.md): historical plans for the `v0.0.1` baseline.
- [Iteration 2: Content Operations](iterations/002-content-operations/README.md): plans,
  [acceptance outcome](iterations/002-content-operations/outcome.md), and observed local evidence.
- [Iteration 3: Framework Leverage](iterations/003-framework-leverage/README.md): reviewed
  baselines, shared command/delivery/recovery adapters and the migrated Content consumer.
  Independent Report Runs and final post-extraction leverage evidence remain planned.

## Internal Notes

Early ideation drafts are archived under [`internal/`](internal/).
