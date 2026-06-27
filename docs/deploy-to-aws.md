# Deploy To AWS

JawStack deploys through AWS CDK. Deployment is opt-in because it creates real AWS resources.

## Prerequisites

- AWS credentials with permission to deploy CDK stacks.
- `AWS_REGION` or `AWS_DEFAULT_REGION`.
- `AWS_PROFILE` when using a named local profile.
- A bootstrapped CDK environment for the target account and region.

Example:

```sh
source "$HOME/.nvm/nvm.sh"
nvm use
export AWS_PROFILE=jawstack-dev
export AWS_REGION=us-east-1
pnpm install
pnpm build
```

Bootstrap CDK if needed:

```sh
pnpm --filter demo-work-requests exec cdk bootstrap
```

CDK bootstrap resources are external prerequisites and are not destroyed by JawStack.

## Preflight

Run deploy readiness checks:

```sh
pnpm --filter demo-work-requests run doctor:deploy
```

This checks local config, cost guardrails, auth mode, AWS region, and available credentials.

## Deploy

```sh
pnpm --filter demo-work-requests run deploy:dev
```

The deploy command delegates to CDK and writes stack outputs to `.jawstack/outputs/dev.json`.

## Smoke Test

```sh
pnpm --filter demo-work-requests run smoke:dev
```

The smoke command discovers the deployed API URL from CDK outputs, creates a Work Request through the API, reads it back, and verifies activity exists.

## One-Command Dev Cycle

The root helper refuses to run unless explicitly confirmed:

```sh
JAWSTACK_AWS_DEV_CONFIRM=deploy-dev pnpm aws:dev:smoke
```

It runs deploy preflight, deploy, smoke, and destroy. To keep the stack for inspection:

```sh
JAWSTACK_AWS_DEV_CONFIRM=deploy-dev JAWSTACK_AWS_DEV_KEEP_STACK=1 pnpm aws:dev:smoke
```

If you keep the stack, destroy it manually when finished.

## Generated Apps

Generated apps expose the same scripts:

```sh
pnpm doctor:deploy
pnpm deploy:dev
pnpm smoke:dev
pnpm destroy:dev
```

The generated `cdk.json` runs `pnpm build:aws` before CDK synth/deploy so Lambda asset directories are current.
