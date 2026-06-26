# JawStack

JawStack is an opinionated TypeScript framework for building event-driven AWS
applications with typed resource contracts, predictable generated architecture,
and explicit cost guardrails.

This repository is in the MVP planning and scaffold stage. The current branch is
building toward the Work Requests resource workflow starter described in
[`docs/prd.md`](docs/prd.md), [`docs/technical-design.md`](docs/technical-design.md),
and [`docs/implementation-plan.md`](docs/implementation-plan.md).

## Development

Prerequisites:

- Node.js 22 or newer
- pnpm 10 or newer

Install dependencies:

```sh
nvm use
pnpm install
```

Run the Phase 0 verification commands:

```sh
pnpm typecheck
pnpm test
pnpm build
```

Useful workspace commands:

```sh
pnpm lint
pnpm format:check
pnpm pkg:check
```

## Packages

Initial workspace packages:

- `@jawstack/core`
- `@jawstack/aws-runtime`
- `@jawstack/aws-cdk`
- `@jawstack/angular`
- `@jawstack/cli`
- `create-jawstack`
