# Destroy Your Stack

Destroy dev stacks when you are done testing. JawStack's default dev removal policy is destroy for generated resources.

## Destroy Demo Dev

```sh
pnpm --filter demo-work-requests run destroy:dev
```

## Destroy A Generated App

From the generated app directory:

```sh
pnpm destroy:dev
```

The command delegates to CDK destroy using the JawStack stage and config path.

## Retained Resources

Expected retained resources:

- CDK bootstrap resources, if you bootstrapped the account and region.
- Any resources you add manually outside the generated JawStack stack.
- Any resources where you intentionally override removal policy to retain.

Generated dev resources should be removable through `destroy:dev`.

## Cleanup Checks

After destroy:

- Confirm the CDK stack is gone in CloudFormation.
- Confirm no generated DynamoDB table remains for the dev stack.
- Confirm no generated Lambda functions remain for the dev stack.
- Confirm no generated SQS queues, EventBridge schedules, or custom event buses remain for the dev stack.

If destroy fails, rerun the command after fixing the reported AWS or CloudFormation issue. Avoid deleting resources manually unless CloudFormation is blocked and you understand the dependency.
