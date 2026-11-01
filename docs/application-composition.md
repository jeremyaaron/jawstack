# Application Composition

The generated Work Requests starter is one consumer, not the framework's only possible
domain. [Content Operations](../apps/content-operations/README.md) demonstrates custom
resources, application queries, Angular pages, objects, workers, and jobs through public
package entrypoints. It is not currently a generator option or a reusable CMS module.

## Core and Persistence

Define server resources with `defineResource` and shared input/state schemas. Decisions
return state, activity, projections, and outbox facts; perform object/provider effects in
workers after commit. A linked read model can use dedicated internal snapshot commands
without becoming a second authority for decisions. Public ingress must explicitly exclude
those commands; a hidden UI button is not authorization.

`ResourceRepository` and `CommandUnitOfWork` separate command reads from atomic commit.
`QueryRepository` is an independent optional read contract, implemented by both
`InMemoryRepository` and `DynamoDbRepository`:

```ts
const page = await repository.queryProjection({
  projectionName: "contentItem.calendar",
  sortFrom: "2026-11-01T00:00:00.000Z",
  sortBefore: "2026-12-01T00:00:00.000Z",
  limit: 50,
});
// Continue with the same scope and page.nextCursor, even after an empty filtered page.
```

`Page<T>` has readonly `items` and optional `nextCursor`. Projection queries have half-open
sort ranges and optional descending order; activity stays ascending. Limits are 1-200,
default 50. Cursors are bounded, unsigned keyset positions, not authentication or snapshot
isolation. Validate application filters/authorization and enforce a candidate budget above
the adapter. Existing `listProjection` / `getActivity` array APIs are unchanged. See the
[core query contract](../packages/core/README.md#paged-reads) and
[DynamoDB adapter](../packages/aws-runtime/README.md#paged-queries).

The AWS package exports item/key mappers and `buildCommandTransactWriteItems`,
`buildResourceStateTransactWriteItem`, and `buildProjectionTransactWriteItem`. Applications
may compose a `CommandUnitOfWork` using these builders rather than private package code.
They must preserve optimistic state conditions and atomic state/activity/outbox/projection/
idempotency semantics. Exact old projection keys require explicit deletes when a sort or
partition changes; unrelated rows must not be erased.

Content Operations captures command/subject/resource scope per invocation, composes typed
command receipts and attempt records into its transaction, coalesces duplicate physical
projection actions, rejects conflicting/duplicate writes, and caps the plan at 60 actions.
It implements seven-day **logical** command expiry with a conditional expired-row replacement,
independently of DynamoDB TTL deletion. Its memory adapter shares the plan. These policies
and its bounded ambiguous-commit replay lookups are **application extensions**, not new
generic framework defaults or an arbitrary public write hook. See the
[persistence protocol](../apps/content-operations/ARCHITECTURE.md#dispatch-and-persistence)
and [command semantics](command.md#idempotency).

## Browser Composition

`@jawstack/angular` exports `ResourceUiDefinition` and `CommandUiDefinition` so UI metadata
can share schemas without importing server decisions or Node/AWS modules. Full resource
definitions remain structurally assignable; the types do not sanitize them at runtime.
Use type-only core imports in browser-safe modules and keep server resource factories out
of the browser graph. Custom pages and typed clients can coexist with generic components.

`FetchJawStackApiClient` throws `JawStackApiError` with HTTP `status`, `code`, opaque
`details`, and optional `correlationId`; transport errors/aborts remain their original
errors. Preserve user input on conflicts and explicitly reload/reconcile rather than
silently retrying stale mutations. See [presentation and errors](../packages/angular/README.md).
The generic client's existing array/list routes do not become the consumer's paged API;
Content Operations owns its typed HTTP queries, fixture header, upload/download, and UI.

## Infrastructure Composition

`JawStackResourceWorkflowApp.workerBindingsByName[name]` returns the named function,
source queue, and DLQ; `schedulerFunctionsByName[scheduleName]` returns the schedule's
function. Unknown names return `undefined`. Names are exact and duplicate declarations
fail early. Existing arrays/default logical IDs remain compatible. Use these public
bindings for application-owned object grants, collector event sources, and selected job
write grants; do not inspect construct-tree children or depend on array positions.

Optional `workerOptions` controls batch size (1-10), DLQ visibility (at least six worker
timeouts, at most 43,200 seconds), and an EventBridge `eventSource` filter. Omitted settings
retain the old defaults. Applications still own collector handlers, durability protocols,
grants, and appropriate concurrency/visibility/log settings. Exposing a DLQ does not
automatically consume it. See the [CDK contract and example](../packages/aws-cdk/README.md).

The consumer's object store, fixture auth, notifications, publisher leases, recovery
ledger, and job checkpoints remain application code. Promote them into a package only
when another concrete consumer establishes the reusable contract. Its local-only
[CDK template](../apps/content-operations/INFRASTRUCTURE.md) and SDK-provisioned lab
are different verification surfaces; neither constitutes production deployment proof.
