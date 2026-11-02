# Recoverable Worker Infrastructure

`recoverableWorkers` is an opt-in on `JawStackResourceWorkflowApp`, not a separate
subscription list or runtime implementation. It adds one collector for each workflow
consumer, attached to that consumer's existing DLQ. Without opt-in the entire legacy
template is unchanged and `collectorFunctionsByName` is a frozen empty record.

## Compose

Reuse the same resource declarations and owned workflow definition as the runtime. Pass
actual prebuilt asset directories or ZIPs containing the existing handler entrypoints:

```ts
import type { Construct } from "constructs";
import type { ResourceDefinition, WorkflowDefinition } from "@jawstack/core";
import {
  JawStackResourceWorkflowApp,
  type JawStackResourceWorkflowEntrypoints,
} from "@jawstack/aws-cdk";

export function createRecoverableBackend(
  scope: Construct,
  definition: WorkflowDefinition,
  resources: readonly ResourceDefinition[],
  entrypoints: JawStackResourceWorkflowEntrypoints,
  collectorHandler: string,
) {
  return new JawStackResourceWorkflowApp(scope, "Workflow", {
    appName: "documents",
    stage: "local",
    resources,
    entrypoints,
    auth: { mode: "external", provider: "application" },
    removalPolicy: "destroy",
    costProfile: {
      lambda: {
        defaultTimeoutSeconds: 30,
        maxTimeoutSeconds: 30,
        defaultMemoryMb: 256,
        reservedConcurrency: 2,
      },
      queues: { defaultMaxConcurrency: 2, maxReceiveCount: 3 },
    },
    recoverableWorkers: { definition, collectorHandler },
  });
}
```

`collectorHandler` is an asset path, not a callback. Its archive/directory must expose
`index.handler`, just like worker assets. That handler composes the public workflow runtime
and delegates to the `.collector` returned by `createWorkflowSqsHandlers`; worker handlers
delegate to `.worker`. The construct does not generate executable code or install a no-op
handler. External ingress authentication remains application-owned; the `auth` declaration
alone does not authenticate requests. This local example's destroy policy is explicit.

Resource names, command names/roles/emissions, worker names/subscriptions/concurrency and
workflow delivery bounds must agree. Unknown recovery options, extra/missing worker-handler
keys, incompatible costs/options, nonexistent collector assets and normalized physical-name
collisions reject before service resources are created. The definition must be owned by
the installed core instance. Equality of manifest metadata does not prove identical schema
or callback bodies; keep one resource/definition source of truth.

## Bounds

The selected profile has at most 40 consumers. Workers and collectors use 30-second
timeouts, 256 MiB, reserved and event-source concurrency two, and batch size one. Both
source queues and collector-facing DLQs use 180-second visibility; source retention is
four days, DLQ retention fourteen days, source redrive three receives, and logs seven days.
Collectors have no secondary DLQ or asynchronous failure destination chain.

When omitted, managed `workerOptions` derive batch/visibility/source from the workflow.
Explicit values must agree; conflicting values are not silently overridden. Cost settings
must resolve to the reviewed bounds. This does not alter ordinary no-opt-in defaults,
including the legacy batch size ten, default DLQ visibility and detail-type-only rules.
The existing outbox sweeper's concurrency-one setting remains unchanged.

These are the iteration's bounded local acceptance settings, not production tuning or
live deployment evidence. In particular, three receives and concurrency two are deliberately
retained for the lab. AWS recommends at least five receives and discusses additional
concurrency considerations; its queue visibility guidance is at least six function
timeouts. Consult [AWS SQS/Lambda configuration](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html)
before designing production limits. Synthesized limits are not proof of actual retry timing.

## Named Grants

`collectorFunctionsByName[consumer]` returns `lambda.Function | undefined`. Its exact
case-sensitive keys derive from the existing workers; the frozen record has no prototype
fallback. Functions remain normal mutable CDK constructs. Keep grants named and explicit:

```ts
import type { Bucket } from "aws-cdk-lib/aws-s3";
import type { JawStackResourceWorkflowApp } from "@jawstack/aws-cdk";

export function grantRenderingObjects(workflow: JawStackResourceWorkflowApp, bucket: Bucket) {
  const worker = workflow.workerBindingsByName.renderDocument;
  const collector = workflow.collectorFunctionsByName.renderDocument;
  if (!worker || !collector) throw new Error("Missing renderDocument bindings.");
  bucket.grantWrite(worker.workerFunction, "rendered/*");
  // Add only if application-owned reconciliation genuinely needs these reads.
  bucket.grantRead(collector, "rendered/*");
}
```

Framework collector grants cover `GetItem`, `Query`, `PutItem`, `DeleteItem` on the exact
table, consumption of only its matching DLQ, and writes to only its own explicit log group.
A dedicated role avoids the broad AWS-managed basic logging policy. Collectors cannot
consume another worker's queue, publish EventBridge events, access S3/jobs or discover/delete
infrastructure through framework grants. Application hooks requiring additional AWS APIs
need explicit grants; those privileges are not inferred from their code.

Opt-in also adds exact-table `DescribeTable`/`ListTagsOfResource` permissions to the API,
outbox, worker, scheduler and collector roles, and a `jawstack:workflow` table tag containing
the manifest hash. Those functions receive `JAWSTACK_WORKFLOW_NAME`, `JAWSTACK_WORKFLOW_HASH`
and `JAWSTACK_EVENT_SOURCE`; publisher entrypoints must use that source/the shared definition,
not guess it from the app name. Existing role data/domain grants are not broadened to other resources.
The local provisioner must still supply owner/lab/profile tags, routing metadata and exact
Lambda context before `createLocalWorkflow` can start. This construct does not create
binding files, inject tokens/credentials/endpoints or claim physical lab ownership.
See [DynamoDB IAM resources](https://docs.aws.amazon.com/service-authorization/latest/reference/list_dynamodb.html).

## Existing Stacks

Collector physical names are `<normalized-app>-<normalized-stage>-<normalized-worker>-collector`.
Leaf construct IDs are `<worker>Collector` and `<worker>CollectorLogs`, matching the existing
Content synthesis composition where compatible. Owning them under the framework changes
their CloudFormation logical IDs and introduces a dedicated role. This is not an in-place
adoption/migration of an already deployed named function; plan logical-ID/import handling
before changing an existing deployed stack. Never deploy an isolated comparison fixture
alongside a stack owning the same physical names.

The Content comparison preserves function names/settings, source/DLQ properties, exact
collector mappings, retention and scoped queue consumption after normalizing logical
references. Collector data/log permissions are intentionally narrower and metadata reads
additive. No Content writer, synthesis stack, local provisioner or handler was switched by
this opt-in release step. Existing custom collectors remain supported without opting in.

All verification here is credential-free synthesis. It is not real AWS IAM enforcement,
SQS redrive or live collector recovery proof; those remain separate acceptance gates.
