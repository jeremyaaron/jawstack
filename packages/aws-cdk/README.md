# @jawstack/aws-cdk

AWS CDK constructs for JawStack applications.

The `JawStackResourceWorkflowApp` construct creates the MVP resource workflow backend:

- DynamoDB table with stream, TTL, and projection/outbox index.
- EventBridge custom bus.
- HTTP API Gateway and API Lambda.
- Outbox dispatcher and sweeper Lambdas.
- Worker queues, DLQs, rules, and Lambdas when configured.
- Scheduler targets and DLQs when configured.
- Explicit Lambda timeout, memory, concurrency, and log retention settings.

Status: `0.0.1` dogfood baseline. APIs are expected to change before `0.1.0`.
