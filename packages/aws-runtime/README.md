# @jawstack/aws-runtime

AWS runtime adapters for JawStack applications.

This package contains:

- DynamoDB repository and transactional unit-of-work adapters.
- DynamoDB item mappers for state, activity, projections, idempotency, outbox, and worker records.
- API Gateway Lambda handler adapter.
- EventBridge publisher and outbox dispatcher/sweeper.
- SQS worker and EventBridge Scheduler target adapters.

Status: `0.0.1` dogfood baseline. APIs are expected to change before `0.1.0`.
