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
