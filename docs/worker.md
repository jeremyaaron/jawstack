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

## Application Composition

The CDK workflow exposes `workerBindingsByName` for the exact named worker function,
source queue, and DLQ. Applications can grant private-object access or attach their own
durable collector through that binding. Optional `workerOptions` controls bounded batch
size, DLQ visibility, and event-source filtering without changing omitted defaults.
See the [public CDK contract](../packages/aws-cdk/README.md#application-composition).

Content Operations runs real materializers, publisher, notification sink, and failure
collectors in the owned LocalStack lab. Transport markers are only retry caches: permanent
business guards, conditional objects, and fenced claims prevent duplicate logical effects
after marker loss. A DLQ binding alone does not implement collection or recovery. See the
[worker and recovery protocols](../apps/content-operations/ARCHITECTURE.md#workers-and-notifications).

## Starter Status

The Work Requests starter includes a placeholder `sendNotification` worker entrypoint. It proves the deployable worker wiring path without requiring a real notification provider.
