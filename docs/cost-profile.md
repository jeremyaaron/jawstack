# Cost Profile

A cost profile is explicit configuration for cost-sensitive infrastructure choices.

JawStack provides guardrails and validation. It does not guarantee a hard AWS spending cap.

## Starter Profile

The starter profile includes:

```ts
export const demoCostProfile = {
  lambda: {
    defaultTimeoutSeconds: 12,
    maxTimeoutSeconds: 30,
    defaultMemoryMb: 384,
    reservedConcurrency: 5,
  },
  queues: {
    defaultMaxConcurrency: 2,
    maxReceiveCount: 3,
    requireDlq: true,
  },
  dynamodb: {
    billingMode: "onDemand",
    maxReadRequestUnits: 100,
    maxWriteRequestUnits: 50,
    pointInTimeRecovery: false,
  },
  eventBridge: {
    preventSelfTriggeringLoops: true,
    requireEventSchemaVersion: true,
  },
  scheduler: {
    maxRetryAttempts: 2,
    maxEventAgeSeconds: 3600,
    requireDlq: true,
  },
} as const;
```

## What Is Enforced

Examples of hard infrastructure settings:

- Lambda timeout.
- Lambda memory.
- Lambda reserved concurrency.
- Queue max receive count.
- Worker max concurrency.
- Scheduler retry policy.
- Log retention.
- Dev removal policy.

Examples of validation or visibility guardrails:

- DynamoDB guardrail fields are explicit.
- EventBridge self-triggering loops are checked.
- Event schema versions are required.
- DLQs are required for queues and schedules.
- Deploy readiness checks require AWS region and credentials.

## What Is Not Guaranteed

JawStack cannot guarantee:

- A universal hard AWS spend cap.
- Protection from all traffic spikes.
- Protection from manually added resources.
- Protection from AWS account-level configuration outside the stack.
- Atomic external side effects in workers.

Use AWS Budgets, account alarms, service quotas, and production review for real environments.

## Validate

```sh
pnpm doctor
pnpm doctor:deploy
```
