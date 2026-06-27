# Worker

A worker is an async consumer for events.

In AWS, JawStack wires workers through:

- EventBridge rule.
- SQS queue.
- SQS DLQ.
- Lambda worker handler.
- SQS event source mapping with maximum concurrency.
- DynamoDB worker idempotency records.

## Worker Behavior

Workers receive event envelopes and run outside the command transaction. They should not be required for the command response to succeed.

Worker handlers must tolerate retries. JawStack records processed `eventId` values in DynamoDB to reduce duplicate execution, but external side effects still need idempotent design.

## Cost And Safety Defaults

Worker cost-sensitive settings are explicit:

- Queue max concurrency.
- Lambda reserved concurrency.
- Max receive count.
- DLQ requirement.
- Visibility timeout derived from Lambda timeout.

`jawstack doctor` reports missing worker guardrails.

## Starter Status

The Work Requests starter includes a placeholder `sendNotification` worker entrypoint. It proves the deployable worker wiring path without requiring a real notification provider.
