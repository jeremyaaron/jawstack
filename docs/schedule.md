# Schedule

A schedule is an EventBridge Scheduler trigger for recurring or delayed work.

The Work Requests starter includes a stale work request reminder example.

## AWS Wiring

JawStack creates:

- EventBridge Scheduler schedule.
- Scheduler Lambda target.
- Scheduler DLQ.
- IAM role for Scheduler to invoke Lambda and write to the DLQ.
- Retry and max event age settings.

## Handler Routing

Scheduler events include a target handler name. The generated scheduler adapter dispatches to the matching handler.

```text
EventBridge Scheduler
  -> scheduler Lambda
  -> target handler
```

## Guardrails

Schedules must configure retry behavior and DLQs. The starter cost profile includes:

- `maxRetryAttempts`
- `maxEventAgeSeconds`
- `requireDlq`

`jawstack doctor` validates these settings.

## Application Jobs

`schedulerFunctionsByName[scheduleName]` exposes each CDK function for selected application
grants, without relying on array positions. The key is the declared schedule name, not its
target handler name; unknown keys return `undefined`. See [named bindings](../packages/aws-cdk/README.md#named-bindings).

Content Operations uses four recurring jobs for due publication, review reminders, upload
expiry, and conservative orphan cleanup. Application-owned checkpoint leases/cursors bound
each pass; the domain rechecks the current revision/schedule generation before acting.
Memory runs these same jobs in a managed loop; the SDK lab proves actual automatic
Scheduler delivery. Neither that proof nor CDK synthesis establishes AWS-equivalent
failed-delivery retry behavior. See [job protocols](../apps/content-operations/ARCHITECTURE.md#due-work-and-maintenance).
