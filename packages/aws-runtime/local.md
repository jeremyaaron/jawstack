# Local Workflow and SQS Recipe

These opt-in APIs use the existing shared command/recovery runtime. They do not provision
infrastructure, start a pump or select credentials/endpoints from a message. Root imports
and legacy `SqsWorkerAdapter` behavior are unchanged.

## Fixed SQS Binding

Bind one registered consumer to its exact trusted source and dead-letter queue ARNs:

```ts
import { createWorkflowSqsHandlers } from "@jawstack/aws-runtime";
import type { WorkflowRuntime } from "@jawstack/core";

export function bindRenderQueues(
  runtime: WorkflowRuntime,
  sourceQueueArn: string,
  deadLetterQueueArn: string,
) {
  return createWorkflowSqsHandlers({
    runtime,
    consumer: "renderDocument",
    sourceQueueArn,
    deadLetterQueueArn,
  });
}
```

The returned `worker(event)` and `collector(event)` accept an unknown SQS input and
return `{ seen, processed, skipped }` only after the full batch succeeds. Each record
requires a bounded unique `messageId`, JSON `body`, exact `eventSourceARN`,
`eventSource: "aws:sqs"`, and matching `awsRegion`. Other AWS metadata is permitted only
as bounded finite plain JSON. The declared consumer's `batchSize` defaults to one;
up to ten requires explicit workflow configuration. Body UTF-8 bytes are bounded at
`2 * manifest.eventBytes + 16384`; the captured batch also has finite JSON/node/depth bounds.

All records are captured and parsed before the first await. Registered schemas, source,
subscription, target identity and any EventBridge outer source/detail-type must agree.
All recorded recovery is authorized before **any** marker/effect in that batch, including
duplicate marker hits and non-target fanout. Each delivery rechecks authorization when
executed, then uses core's business -> durable completion -> marker order. Invalid final
records cannot be hidden by an earlier duplicate or partially processed batch.

Any failure or deferred admission throws for whole-batch retry. There is no partial-batch
response or deletion API here. Earlier successful records may already have durable markers;
retry skips those, but this is not a transaction across business effects in multiple records.
Use retry-safe business effects. This matches the selected whole-batch failure policy;
see [Lambda SQS error handling](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html).
Do not expose these handlers as public HTTP commands or choose their consumer/queue from input.

## Local Routing Data

`parseLocalWorkflowBindings(unknown)` is pure and accepts either JSON text or a plain
JSON value, capped at 64 KiB. It returns a detached deeply frozen schema-version-1 value.
Unknown fields, getters/prototypes/nonfinite values, duplicate functions/queues/consumers,
missing worker/collector pairs and foreign namespaces reject with a fixed error. Nothing
reads files, dotenv or environment variables during parsing/import.

The required data shape is:

```ts
import type { LocalWorkflowBindings } from "@jawstack/aws-runtime/local";
import type { WorkflowDefinition } from "@jawstack/core";

// Illustrative profile data: the owned provisioner must create/tag these exact resources.
export function exampleBindings(definition: WorkflowDefinition): LocalWorkflowBindings {
  return {
    schemaVersion: 1,
    workflow: {
      name: definition.manifest.name,
      source: definition.manifest.source,
      hash: definition.manifest.hash,
    },
    profile: { name: "documents-local", hash: "b".repeat(64) },
    lab: {
      id: "documents",
      project: "jawstack-documents",
      ownerId: "10000000-0000-4000-8000-000000000001",
    },
    accountId: "000000000000",
    region: "us-east-1",
    tableName: "jawstack-documents-state",
    eventBusName: "jawstack-documents-events",
    functions: [
      { name: "jawstack-documents-render", role: "worker", consumer: "renderDocument" },
      { name: "jawstack-documents-collector", role: "collector", consumer: "renderDocument" },
      { name: "jawstack-documents-outbox", role: "dispatcher" },
    ],
    consumers: [
      {
        consumer: "renderDocument",
        sourceQueueArn: "arn:aws:sqs:us-east-1:000000000000:jawstack-documents-render",
        deadLetterQueueArn: "arn:aws:sqs:us-east-1:000000000000:jawstack-documents-render-dlq",
      },
    ],
  };
}
```

Optional `services` contains only `bucketName` and/or `scheduleGroupName`; a `jobs`
function requires a schedule group. Function roles are `api`, `dispatcher`, `worker`,
`collector`, `jobs` or `proof`; only worker/collector entries carry a consumer. All names
use the declared lab project prefix. There is exactly one worker/collector pair per
registered consumer. Tables/buses/functions use the intentionally bounded lowercase
3-63 character profile naming subset, not all possible AWS resource names. FIFO queues
and alternate regions/accounts are outside this initial local profile.

Routing contains no credentials, token, endpoint override, filesystem/archive paths or
executable callbacks. Profile hashes are supplied by trusted provisioner configuration;
they are not authentication secrets. Independently select expected profile/lab identity
from the trusted launcher, rather than trusting the routing file to attest to itself.
These illustrative hashes/UUIDs do not establish resource ownership. Shared provisioning
and binding-file emission are later phases; existing Content Operations has not migrated.

## Construct the Local Runtime

Continue with the definition/business binding from the [Dynamo recipe](workflows.md).
Application callbacks are the same `WorkflowRuntimeOptions` used for memory/Dynamo:

```ts
import {
  createLocalWorkflow,
  parseLocalWorkflowBindings,
  type LocalWorkflowOptions,
} from "@jawstack/aws-runtime/local";
import type { WorkflowDefinition, WorkflowRuntimeOptions } from "@jawstack/core";

export async function openLocalApplication(
  definition: WorkflowDefinition,
  routingJson: string,
  expected: Pick<LocalWorkflowOptions, "profile" | "lab">,
  callbacks: WorkflowRuntimeOptions,
) {
  return createLocalWorkflow(definition, {
    ...callbacks,
    ...expected,
    bindings: parseLocalWorkflowBindings(routingJson),
    execution: { kind: "host" },
  });
}
```

This async factory validates the owned definition, routing/expected identities, complete
consumer registration and callback options before constructing a client. It checks an
ACTIVE exact table ARN/name and string PK/SK schema, then table tags `jawstack:owner`
(owner UUID), `jawstack:lab` (lab ID), `jawstack:workflow` (manifest hash),
`jawstack:profile` (profile hash). Missing/duplicate/mismatched tags or unconsumed tag
pagination fail closed. The application binding runs only after ownership succeeds;
there are no business reads/writes beforehand. No table is adopted, created or repaired.
The runtime needs explicit local metadata-read permissions in addition to business grants.

After startup it exposes the same Dynamo workflow services with no memory pump. It owns
and closes its client through core's guarded close lifecycle, including cleanup on startup
failure. Rejected/invalid close calls cannot dispose a still-ready runtime. Do not keep
using services after close. Ownership is checked at construction, not atomically with
every later business transaction; do not reset/reassign the lab under an active runtime.

For Lambda, pass `execution: { kind: "lambda", functionName, invokedFunctionArn, role,
consumer }` from trusted entrypoint/context composition, not event data. `consumer` is
required only for worker/collector roles. The exact unqualified dummy-account function ARN,
function name, declared role/consumer and `AWS_LAMBDA_FUNCTION_NAME` must match. Route a
worker entrypoint to `.worker`, its separate collector entrypoint to `.collector`, and
close in `finally`. Aliases/versions and arbitrary function names are not silently adopted.

## Local Transport Policy

`createLocalAwsTransport({ execution })` returns compatible SDK client settings:
host `http://127.0.0.1:4566` or Lambda `http://localstack:4566`, region `us-east-1`,
explicit `test`/`test` credentials, at most two attempts, 1-second connection and 5-second
request timeouts. Its owned `requestHandler` validates the final protocol/hostname/port,
Host header and absence of URL credentials **before** the native HTTP handler. Redirects,
service-discovered alternate hosts, S3 virtual-host endpoints and user overrides cannot
escape that check. S3 callers must use path-style addressing and disable region redirects;
SQS management clients must set `useQueueUrlAsEndpoint: false` and validate owned queue URLs.
Destroy the client/handler when finished. This transport policy does not itself prove
ownership of a table, bucket or queue; management/application services must check ownership.

Nonempty inherited `AWS_*` settings fail on host except matching region/default-region
and `AWS_EC2_METADATA_DISABLED=true`. Lambda permits only the enumerated matching runtime
metadata, dummy/emulator-prefixed credential metadata and canonical local endpoint metadata.
LocalStack's matching private bridge endpoint is metadata only: the actual destination
always remains `localstack:4566`. Profile/config files, real-looking keys, web identity,
container credential providers and service endpoint overrides fail before SDK requests.
Emulator credentials are never used; a fixed provider returns fresh mutable `test`/`test`
identities so SDK feature annotations work without sharing/fixing a frozen SDK identity. See
[LocalStack credential conventions](https://docs.localstack.cloud/aws/connecting/credentials/).

The guard is deliberate local policy, not a sandbox against malicious application code,
DNS/network administrators or a production cloud authentication/deployment facility. Real
AWS deployment and IAM enforcement, actual Lambda environment/queue delivery and complete
LocalStack scenarios remain separate acceptance gates. No real-AWS fallback exists.
