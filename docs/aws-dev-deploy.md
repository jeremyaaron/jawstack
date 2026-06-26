# AWS Dev Deploy Smoke

Phase 21 adds an opt-in path for the first real JawStack AWS dev deployment.

This is intentionally not part of default CI. It creates real AWS resources, runs the Work Requests smoke test, and destroys the dev stack.

## Prerequisites

- Node and pnpm from the repository `.nvmrc` and `packageManager`.
- AWS credentials that can deploy CDK stacks.
- A bootstrapped CDK environment in the target account and region.
- `AWS_REGION` or `AWS_DEFAULT_REGION` set.
- `AWS_PROFILE` set when using a named local profile.

Example:

```sh
source "$HOME/.nvm/nvm.sh"
nvm use
export AWS_PROFILE=jawstack-dev
export AWS_REGION=us-east-1
pnpm install
pnpm build
```

If the target account and region are not bootstrapped yet:

```sh
pnpm --filter demo-work-requests exec cdk bootstrap
```

The bootstrap stack is owned by CDK and is not destroyed by JawStack.

## Manual Commands

Run the deploy preflight:

```sh
pnpm --filter demo-work-requests run doctor:deploy
```

Deploy the dev stack:

```sh
pnpm --filter demo-work-requests run deploy:dev
```

Run the deployed smoke test:

```sh
pnpm --filter demo-work-requests run smoke:dev
```

Destroy the dev stack:

```sh
pnpm --filter demo-work-requests run destroy:dev
```

## One-Command Dev Cycle

The root script requires an explicit confirmation variable:

```sh
JAWSTACK_AWS_DEV_CONFIRM=deploy-dev pnpm aws:dev:smoke
```

The script runs:

1. `doctor:deploy`
2. `deploy:dev`
3. `smoke:dev`
4. `destroy:dev`

To inspect resources after smoke, keep the stack:

```sh
JAWSTACK_AWS_DEV_CONFIRM=deploy-dev JAWSTACK_AWS_DEV_KEEP_STACK=1 pnpm aws:dev:smoke
```

If the stack is kept, destroy it manually before stopping:

```sh
pnpm --filter demo-work-requests run destroy:dev
```

## Generated App Path

Generated apps include the same scripts:

```sh
pnpm doctor:deploy
pnpm deploy:dev
pnpm smoke:dev
pnpm destroy:dev
```

The generated app's `cdk.json` builds Lambda assets before synth, deploy, and destroy by running `pnpm build:aws`.

## Cost and Cleanup Notes

- Dev stacks use the JawStack default removal policy of destroy.
- DynamoDB is on-demand and point-in-time recovery is off in the starter cost profile.
- Lambda memory, timeout, and reserved concurrency are explicit in the starter cost profile.
- SQS queues and DLQs are created only for configured workers and schedulers.
- The Work Requests starter currently deploys API, table, event bus, outbox dispatcher, and outbox sweeper resources.
- CDK bootstrap resources are external prerequisites and are intentionally retained.
- CloudWatch log groups created by the JawStack construct use the same removal policy as the stack.
