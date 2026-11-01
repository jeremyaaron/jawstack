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

## Named Bindings

`JawStackResourceWorkflowApp` exposes two additive readonly records:

- `workerBindingsByName[workerName]` returns a `JawStackWorkerBinding` containing
  `workerFunction: lambda.Function`, `queue: sqs.Queue`, and `deadLetterQueue: sqs.Queue`.
- `schedulerFunctionsByName[scheduleName]` returns that schedule's `lambda.Function`.
  Keys are the declared schedule names, not `targetHandler` names. Multiple schedules may
  share a handler entrypoint while retaining their own functions and bindings.

Keys use exact, case-sensitive declared names, not normalized AWS physical names. Worker
names must be unique across all resource definitions; schedule names must likewise be
unique across resources. The two namespaces are independent. Duplicates and missing/blank
handler entrypoints fail before infrastructure is created. Handler records must have their
own named entries rather than inheriting paths from an object prototype. Unknown map keys
return `undefined`, including names inherited by ordinary JavaScript objects; check lookups
and report the missing application capability explicitly. Lookup types include `undefined`
even when a consuming project does not enable `noUncheckedIndexedAccess`.

Maps and worker-binding wrappers are frozen. Their CDK functions/queues remain ordinary
mutable constructs so applications can add grants and event sources. Existing props,
`workerFunctions`, `workerQueues`, `schedulerFunctions`, `schedulerDlqs`, array order, logical
IDs, and default infrastructure/permissions are unchanged. Bindings reference the same
objects as the existing arrays; they do not create replacement resources or auto-grant
application permissions.

## Application Composition

Optional `workerOptions` on `JawStackResourceWorkflowApp` lets a consumer set `batchSize`
(integer 1-10), `deadLetterVisibilityTimeoutSeconds` (at least six function timeouts,
at most 43,200 seconds), and an `eventSource` filter for worker EventBridge rules. Invalid
options fail before service resources are created. Omitted settings retain batch size ten,
the SQS default DLQ visibility, and the original detail-type-only rules. Existing logical
IDs, named bindings, generated consumers, and default policies remain unchanged.

These settings let an application-owned collector share its worker's bounded timeout/DLQ
visibility and let local integration use single-message batches without editing child
constructs. Applications still own collector functions, grants, and event sources.

Given an existing workflow, a private artifact bucket, and an application-owned failure
collector function, compose permissions and collection through public bindings:

```ts
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";

const publisher = workflow.workerBindingsByName.publishContent;
const tick = workflow.schedulerFunctionsByName.publicationTick;
if (!publisher) throw new Error("Missing publishContent worker binding.");
if (!tick) throw new Error("Missing publicationTick scheduler binding.");

bucket.grantReadWrite(publisher.workerFunction, "publications/*");
workflow.table.grantWriteData(tick);
workflow.table.grantReadWriteData(failureCollector);
failureCollector.addEventSource(
  new SqsEventSource(publisher.deadLetterQueue, { batchSize: 1, maxConcurrency: 2 }),
);
```

This targets the named functions and DLQ without inspecting construct-tree children or
depending on array positions. Schedulers retain table-read access by default; only the
selected function receives the explicit write grant. The collector's runtime handler,
durability/idempotency protocol, timeout/queue-visibility compatibility, concurrency, and
log retention remain application responsibilities. Exposing a DLQ does not consume its
messages or install a collector automatically.

Synth tests assert the resulting policies/event sources and preserve a baseline logical-ID
snapshot. Synthesis makes no AWS requests and is not evidence of deployment or live IAM
enforcement. The composition uses standard CDK [bucket grants](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3.Bucket.html),
[table grants](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_dynamodb.Table.html),
and [SQS event sources](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda_event_sources.SqsEventSource.html).
