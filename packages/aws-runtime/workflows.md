# DynamoDB Workflow Recipe

`createDynamoWorkflow` uses the same declaration, binding, command executor and recovery
protocol as core's memory workflow. Only the storage composition changes. It neither
creates a client/table nor starts a timer, server, publisher, stream reader or queue poller.
Legacy repositories, unit-of-work adapters and item builders remain unchanged.

## Declare and Bind

This complete backend example imports only supported package exports. The rendering port
is application-owned: `renderOnce` must enforce immutable business identity and safe retry
semantics at the actual provider/store, not rely on a workflow marker as a lock.

```ts
import { z } from "zod";
import {
  defineAtomicRecord,
  defineCommand,
  defineResource,
  defineState,
  defineWorker,
  defineWorkflow,
  field,
  type WorkflowRuntime,
} from "@jawstack/core";
import { createDynamoWorkflow, type DynamoDbClientLike } from "@jawstack/aws-runtime";

const payload = z.strictObject({ documentId: z.string(), title: z.string() });
export const receipt = defineAtomicRecord({
  name: "receipt",
  schema: z.strictObject({ documentId: z.string(), version: z.number().int().positive() }),
  key: (value) => `${value.documentId}#${value.version}`,
  owner: (value) => ({ resourceType: "document", resourceId: value.documentId }),
});
export const definition = defineWorkflow({
  name: "documents",
  source: "documents",
  resources: [
    defineResource({
      name: "document",
      title: "Document",
      state: defineState({ title: field.string() }),
      commands: {
        create: defineCommand({
          title: "Create",
          create: true,
          roles: ["operator"],
          input: z.strictObject({ title: z.string().trim() }),
          emits: [{ eventType: "document.created", schemaVersion: 1 }],
          decide: ({ input, resourceId }) => ({
            nextState: input,
            response: { id: resourceId },
            activity: [{ activityType: "created", title: "Created" }],
            projections: [
              {
                projectionName: "document.list",
                itemId: resourceId,
                sort: "created",
                data: input,
              },
            ],
            events: [
              {
                eventType: "document.created",
                schemaVersion: 1,
                payload: { documentId: resourceId, title: input.title },
              },
            ],
          }),
        }),
      },
      workers: [defineWorker({ name: "renderDocument", eventTypes: ["document.created"] })],
    }),
  ],
  records: [receipt],
  contribute: ({ commit }) => ({
    records: [
      receipt.create({
        documentId: commit.resource.resourceId,
        version: commit.resource.next.version,
      }),
    ],
  }),
  commands: { idempotencyTtlSeconds: 604800, maxActions: 60 },
  events: [
    {
      eventType: "document.created",
      schemaVersion: 1,
      schema: payload,
      validateIdentity: (event) =>
        event.resourceType === "document" && event.resourceId === event.payload.documentId,
    },
  ],
  consumers: { renderDocument: { recovery: "replay" } },
  operations: { resourceType: "document", projection: "document.failures" },
});

export function createDocuments(
  client: DynamoDbClientLike,
  tableName: string,
  rendering: {
    renderOnce(
      document: { documentId: string; title: string; originalEventId: string },
      signal: AbortSignal,
    ): Promise<void>;
  },
): WorkflowRuntime {
  return createDynamoWorkflow(definition, {
    client,
    tableName,
    authorizeOperations: (auth) => auth.subject === "operator" && auth.roles.includes("operator"),
    bind: () => ({
      renderDocument: {
        handle: async (event, { signal }) => {
          signal.throwIfAborted();
          const fact = payload.parse(event.payload);
          await rendering.renderOnce({ ...fact, originalEventId: event.originalEventId }, signal);
        },
      },
    }),
  });
}
```

Supply a configured, bounded SDK `DynamoDBClient` (structurally compatible with
`DynamoDbClientLike`) and an explicitly selected dedicated table. There is no default
endpoint, region, credential provider, table selection or implicit network construction.
For LocalStack use an explicit dummy-credential client with a final-destination guard;
the public `@jawstack/aws-runtime/local` factory supplies that guard and owned-table checks.
See the [local/SQS recipe](local.md) for the supported configuration and exact queue binding.

The table needs string `PK`/`SK` keys. Command storage itself needs no secondary index,
stream or TTL configuration. An outbox dispatcher additionally needs the existing outbox
GSI/stream infrastructure and permissions; this factory does not provision or run it.
Enable DynamoDB TTL on `expiresAt` for eventual cleanup if desired. Logical idempotency
and marker expiry are enforced even when TTL is disabled or physical deletion is delayed.
Failure history has no TTL. Restrict table access with deployment/IAM policy; reads still
need application authorization. No scan, table discovery or adoption occurs on startup.

## Use the Services

After `const workflow = createDocuments(client, tableName, rendering)`, dispatch with a
server-authenticated `AuthContext` exactly as in the [core workflow recipe](https://github.com/jeremyaaron/jawstack/blob/main/packages/core/workflows.md).
Use `workflow.records.get(receipt, documentId + "#1")` for typed auxiliary reads,
`repository.getState` for state, and `queries` for bounded projection/activity keyset pages.
The public runtime has no raw transaction fragments, memory store, `drain` or `start`.

An authenticated internal transport may pass a validated fact to
`workflow.delivery.handle("renderDocument", fact)`. After exhausted transport attempts,
its collector calls `delivery.collect`. Authorized operators inspect through
`operations.inspect(auth)` and request `operations.replay(id, auth, requestUuid)`.
The replay transaction appends history and the create-only outbox fact together; an
external dispatcher/transport must actually deliver it. These calls are not public HTTP
endpoints. Use `createWorkflowSqsHandlers` for whole-batch validation and exact queue binding.

The same core rules apply: exact registered schemas/source/identity, scoped normalized
idempotency, authorization before cached results and recovery markers, bounded winner
readback without rerunning command decisions, monotonic recovery history, and business
completion -> durable ledger completion -> processing marker. Inspection exposes summaries,
not private original envelopes. `close` aborts/waits for active work; it does not destroy
the borrowed client. The owner must close its client after all runtimes are closed.

## Atomicity and Bounds

For command-only adapter composition, `createDynamoWorkflowStorage(spec, client, tableName)`
accepts the owned specification from core's `createWorkflowStorageSpec(definition)`.
Pass its `command` factory to `createWorkflowCommandDispatch`; use the same declaration's
resources and source. No driver starts and no consumer binding is required. Construction
performs no SDK calls, and the same client/table declaration-ownership guard applies as
with `createDynamoWorkflow`. The owner supplies and closes the client and owns authorization.
Do not expose raw storage ports to untrusted callers. Prefer the full workflow factory for
new applications that also need delivery/recovery.

`compileWorkflowCommit(spec.planner, ownedPlan, tableName)` is the corresponding adapter-author
compiler. It accepts only a plan owned by that exact planner, enforces the existing bounds
and returns the SDK input plus ordered condition roles. It is not an arbitrary transaction
builder, and the normal storage adapter remains responsible for strong preflight reads,
condition/error handling and atomic send. Applications contribute registered records and
projections, not caller-authored SDK fragments or conditions.

Each command compiles its own planner's opaque plan into one `TransactWriteItems` call:
primary version/create condition, create-only activity/outbox/auxiliary contributions,
exact projection deletes/puts, and absent-or-expired scoped idempotency. All categories
roll back together. Recovery history uses version CAS, its reserved projection, and an
optional create-only replay outbox in one transaction. There is no splitting or fallback.

All replay/CAS reads are strong. Stored rows are validated before decoding away storage
metadata, before logical expiry, and before overwriting replaceable rows. Corruption is
`resource.invalid_state`, not a cache miss. Ordered, complete known cancellation reasons
classify scoped idempotency versus other conditional conflicts. Missing/unknown reasons,
transport loss and uncertain service errors remain sanitized `runtime.unavailable`; core
performs bounded strong readback. A successful readback does not rerun the decision.

The workflow cap is 60 actions, narrower than DynamoDB's service cap. The compiler also
conservatively bounds encoded item JSON at 400 KiB and the complete SDK request at 4 MiB,
including wrappers/conditions and observed existing projection-delete sizes from preflight
reads. Concurrent external changes remain subject to DynamoDB's authoritative limits.
It rejects oversized requests before any write. Logical
planner limits (192 KiB ordinary action, 64 KiB auxiliary, 1 MiB whole plan and JSON
depth/node bounds) still apply. See the official
[transaction API](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html).
Deterministic 36-character client request tokens cover identical compiled SDK retries,
not an alternative to scoped command idempotency or failure CAS.

## Compatibility and Ownership

Existing state/activity/outbox/projection/idempotency builders encode the rows. Auxiliary
values remain flat `APP_OPERATION` rows at `OPS#collection`/logical-key; typed registered
key/owner functions validate reads without inventing colliding hidden business fields.
Failures remain `APP_FAILURE` at `FAILURE#id`/`DELIVERY`; processing and collector markers
retain the existing seven-day `WORKER_IDEMPOTENCY` shape.

Legacy durable markers store event ID, not a full-envelope fingerprint. Unlike memory's
additional process-local fingerprint check, they cannot detect a different ordinary fact
reusing an already-processed transport ID. Preserve unique immutable transport identity
and business deduplication. Recorded recovery is still checked against exact durable
history before **any** marker read, so a marker cannot authorize a forged replay. Neither
backend promises exactly-once effects or locks concurrent handlers.

A process-local guard rejects differing manifest hashes on the same client/table pair;
equivalent API/worker compositions may share it. This is not physical ownership verification,
a schema migration, or proof of identical callback/schema code. Different clients/processes
need the same dedicated-table and deployment ownership discipline. Do not mix unrelated
workflows or legacy/new active writers in one table. Existing Content Operations writers
are not migrated by choosing this API; that is a separately verified later phase.
