# Memory Workflow Recipe

These supported backend imports compose a working memory workflow. No service, timer or
cloud client starts during declaration or construction. Storage is process-local and is
not a substitute for a durable database. Existing legacy factories remain available.

## Declare and Bind

The declaration owns schemas and policies; `defineWorker` remains the only subscription
list. Binding supplies actual business handlers, not new subscriptions. Contributions
are synchronous, pure, registered creates applied with the command transaction.

```ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  defineAtomicRecord,
  defineCommand,
  defineResource,
  defineState,
  defineWorker,
  defineWorkflow,
  createMemoryWorkflow,
  JawStackRuntimeError,
  field,
  type AuthContext,
} from "@jawstack/core";

const payload = z.strictObject({ documentId: z.string(), title: z.string() });
const receipt = defineAtomicRecord({
  name: "receipt",
  schema: z.strictObject({ documentId: z.string(), version: z.number().int().positive() }),
  key: (value) => `${value.documentId}#${value.version}`,
  owner: (value) => ({ resourceType: "document", resourceId: value.documentId }),
});
const document = defineResource({
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
});
const definition = defineWorkflow({
  name: "documents",
  source: "documents",
  resources: [document],
  commands: { idempotencyTtlSeconds: 604800, maxActions: 60 },
  records: [receipt],
  contribute: ({ commit }) => ({
    records: [
      receipt.create({
        documentId: commit.resource.resourceId,
        version: commit.resource.next.version,
      }),
    ],
  }),
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

// A tiny application-owned effect, intentionally unavailable for the recovery exercise.
const rendered = new Map<string, { originalEventId: string; title: string; output: string }>();
let providerAvailable = false;
let now = Date.parse("2026-11-01T12:00:00.000Z");
const workflow = createMemoryWorkflow(definition, {
  clock: () => new Date(now),
  authorizeOperations: (auth) => auth.subject === "operator" && auth.roles.includes("operator"),
  bind: () => ({
    renderDocument: {
      handle: async (event, { signal }) => {
        signal.throwIfAborted();
        if (!providerAvailable) throw new Error("Provider unavailable.");
        const fact = payload.parse(event.payload);
        const previous = rendered.get(fact.documentId);
        if (
          previous &&
          (previous.title !== fact.title || previous.originalEventId !== event.originalEventId)
        )
          throw new JawStackRuntimeError("resource.conflict", "Immutable document differs.");
        if (previous) return "ignored" as const;
        rendered.set(fact.documentId, {
          originalEventId: event.originalEventId,
          title: fact.title,
          output: fact.title.toUpperCase(),
        });
      },
    },
  }),
});
const operator: AuthContext = {
  subject: "operator",
  roles: ["operator"],
  claims: {},
  mode: "test",
};
```

Ingress must authenticate and resolve `AuthContext`, authorize endpoints and allowlist
commands. Neither a body-supplied role nor this example's local identity is production
authentication. `requestContext` is discarded and never passed into workflow hooks.

## Dispatch and Recover

Continue the same example. Draining does not advance the clock or sleep through retries.

```ts
const documentId = randomUUID();
const result = await workflow.dispatch(
  {
    resourceType: "document",
    resourceId: documentId,
    commandName: "create",
    input: { title: "A draft" },
    idempotencyKey: `create:${documentId}`,
    requestContext: {},
  },
  operator,
);
if (!result.ok) throw new Error(result.error.code);

await workflow.drain(); // first attempt
now += 1000;
await workflow.drain(); // second attempt
now += 2000;
await workflow.drain(); // third attempt, then durable collection

const page = await workflow.operations.inspect(operator);
if (!("items" in page) || !page.items[0]) throw new Error("Expected a collected failure.");
providerAvailable = true;
await workflow.operations.replay(page.items[0].id, operator, randomUUID());
const drained = await workflow.drainUntilIdle();
if (!drained.idle) throw new Error("Work remains deferred.");

const storedReceipt = await workflow.records.get(receipt, `${documentId}#1`);
const failure = await workflow.operations.inspect(operator, { id: page.items[0].id });
console.log(rendered.get(documentId), storedReceipt, failure);
await workflow.close();
```

`dispatch` retains core authorization, schema-normalized fingerprints and structured
results. Mandatory keys are ASCII `[A-Za-z0-9_.:-]`, 1-200 characters, scoped to resource
type, command and subject. Explicit target IDs participate in matching. Logical expiry
does not depend on physical TTL deletion. Ambiguous outcomes never rerun a mutation
decision; the runtime uses bounded winner reads and the existing executor's replay path.

`records.get(definition, logicalKey)` accepts only the exact registered definition and
returns a detached typed value, not a write capability. `repository.getState` and keyset
`queries` address registered resource namespaces. Reads do not replace application
authorization. Operational projections are reserved: use authorized `operations` rather
than reading or overwriting those projections through ordinary commands/queries.

## Consumers and Operations

Binding is synchronous and must return exactly the declared worker names. Every entry
requires a `handle`; optional hooks are `reconcileFailure` and `authorizeReplay`. No
placeholder handler is installed. Missing, extra, inherited, asynchronous or unknown
bindings fail. Framework service execution during binding, including inherited deferred
startup work, is rejected. Callbacks remain trusted application code, not a security sandbox.

Handlers receive frozen schema-normalized business payloads, `originalEventId`, optional
four-field `recovery` metadata and an `AbortSignal`. They return normally or explicitly
return `"ignored"`; other outcomes reject. Recorded recovery is authenticated before
markers, even on cache hits and ignored fanout. Business completion precedes durable
recovery completion, which precedes a successful processing marker. Concurrent handlers
may both enter before a marker exists. Markers are not locks or exactly-once guarantees;
business effects need immutable identity, source-version/fence checks and safe retries.

`events.parse` validates canonical plain or EventBridge-wrapped facts; outer source/type
must match the inner envelope. Parsing is not authorization. `events.fact` additionally
forbids recovery metadata. Registered schemas must be synchronous object schemas, strict
and stable under revalidation. Identity validators are pure and must return `true`.
Tenant envelopes and unrecorded/two-field legacy recovery metadata are rejected by this
default composition. Do not expose `delivery` methods as user HTTP routes.

`operations.inspect(auth, { id })` returns a summary; `inspect(auth, { limit, cursor })`
returns a paged summary list, not the private original envelope. Pages default to 50,
maximum 100. Root operations
authorization must explicitly return `true`; absence/errors deny. `replay` requires a UUID
request ID, explicit `replay` consumer policy and an unresolved reconciled latest generation.
An optional eligibility hook may only further restrict new requests.
Backend `authorizeReplay` also receives a detached frozen
`original` fact, so eligibility can compare its immutable intent/digest against business
authority. This private hook value is never added to inspection/HTTP summaries. Existing request IDs
return recorded history with fresh root authorization. A queued cycle does not consume
another generation. Three cycles are allowed; history has no TTL. `application` policy
permits inspection/collection but forbids generic replay.

`reconcileFailure({ failure, generation })` receives a frozen private DTO and returns
`notApplicable`, `stalled`, `failed`, `superseded` or `succeeded`. Absence defaults to
`notApplicable`; errors leave durable pending work unacknowledged. Hooks must be repeatable,
strongly reread business authority and use domain versions/fences. Ordinary business commands
are allowed; direct ledger writes/reentry are blocked. Application reconciliation and the
ledger are separate transactions. The framework never infers business success from a marker
or object. `validateResult` may reject stale successful authority through a structured
runtime error, but cannot rewrite responses, turn errors into success or commit new work.

## Driver and Limits

`drain(limit = 50, signal?)` serializes passes, admitting complete event fanout or leaving
the cursor unconsumed. Limits are 1-100; three worker attempts use injected-clock +1/+2
second cutoffs. Collector failures defer for one second. Pending/terminal work and live
markers are never evicted to admit new work. `drainUntilIdle({ maxPasses: 20, limit: 50 })`
allows at most 100 passes and reports deferred/backpressured/exhausted work explicitly.

Memory options `maxJobs`, `maxMarkers`, `maxCollectionMarkers`, `maxFailures` default to
200/1000/1000/1000 under `memory`; each accepts integers 1-10,000. Markers expire after
seven days; failure rows do not. Facts default to 80 KiB (`eventBytes` may be narrower),
failure rows to 128 KiB, and command plans retain the shared commit limits. Backing outbox
arrays are append-only; resetting/changing their consumed boundary requires a fresh runtime.
The exposed `store` supports existing trusted domain writers, not arbitrary untrusted writes.

For wall-clock managed operation, omit the example's fake clock and start explicitly:

```ts
const driver = workflow.start({ intervalMs: 1000 });
void driver.done.catch(console.error);
// Later, outside a handler:
await driver.stop({ timeoutMs: 5000 });
await workflow.close({ timeoutMs: 5000 });
```

Use this lifecycle block instead of closing immediately in the manual-drain example.
Only one driver runs at a time; stop permits a later start. Close aborts and waits for
active work and adapter cleanup. Stop/close timeouts are 1-30,000 ms, default 5,000.
Uncooperative handlers can outlive a timeout: the method rejects rather than claiming
cleanup succeeded. Honor the supplied signal and configure bounded external operations.
Never drive or close a workflow from its own handler. Construction never starts a driver.

## Adapter Authors

Complete new applications should use `createMemoryWorkflow` or `createDynamoWorkflow`.
Existing consumers with domain-owned services can compose the same implementation through
public adapter entries, without copying its algorithms:

- `createWorkflowStorageSpec(definition)` exposes the owned planner, failure protocol,
  immutable manifest, `parse` (including EventBridge detail unwrapping), `fact` and stored
  value validators.
- `createMemoryWorkflowFailureStore({ persistence, protocol, maxRecords? })` mounts once
  on shared memory persistence; failure history, its projection and replay outbox publish
  through the same atomic lock as commands.
- `createWorkflowFailureService({ protocol, store, authorizeOperations, hooks, clock? })`
  owns collection, durable replay authorization/CAS and completion. Reconciliation and
  replay policy are bound hooks, not a copied state machine. An optional programmatic
  `fault` callback supports interrupted-commit tests; never select it from ingress or
  production environment variables.
- `createWorkflowDelivery({ definition, failures, markers, bindings, clock, signal, run })`
  captures an exact consumer binding map. It owns validation-before-marker ordering and
  replay completion. Handlers return void or `"ignored"`, not transport acknowledgements.
- `createMemoryWorkflowMarkers(deliveryCapacity, collectionCapacity)` and
  `createWorkflowPump({ outbox, parse, subscribers, delivery, clock, signal, maxJobs,
markerCounts, run, check })` provide the same bounded marker/pump implementation.
  `run` and `check` belong to the adapter's lifecycle owner. Do not start a shared driver
  alongside an existing managed HTTP loop; stop that loop and await its drains on shutdown.

These are trusted backend composition ports, not HTTP APIs. They do not confer automatic
lifecycle ownership, validate arbitrary application effects or close borrowed clients.
`failedDeliveryId` and `envelopeFingerprint` expose canonical identity helpers; applications
must not construct or authorize replay metadata from those hashes alone.

For command-only composition, use `createWorkflowStorageSpec(definition)` to obtain the
same owned, frozen planner/validation specification used by `createWorkflowRuntime`.
`createMemoryWorkflowPersistence({ planner: spec.planner, store? })` supplies scoped
`factory` and validated `repository` ports while retaining its backing `InMemoryStore`.
The store must be empty and exclusively owned. Its maps/commit ports are low-level
adapter/testing facilities, not an application authorization boundary or HTTP interface.

```ts
const spec = createWorkflowStorageSpec(definition);
const memory = createMemoryWorkflowPersistence({ planner: spec.planner });
const dispatch = createWorkflowCommandDispatch({
  registry: resources,
  source: spec.manifest.source,
  persistence: memory.factory,
  validateResult,
});
```

`resources` must be the declaration's resource definitions; `validateResult` is optional
and follows the read-only result-hook contract above. This composition starts no delivery
driver and requires no placeholder consumer bindings. It is useful when migrating commands
before an existing delivery owner. The adapter owner controls shutdown and borrowed
dependencies; prefer `createMemoryWorkflow` for a complete new application. Request payload
capture rejects non-JSON/invalid-UTF-8 input as `command.validation` before persistence;
invalid mandatory identity/key components remain `command.rejected`.

`createWorkflowRuntime(definition, createStorage, options)` is a backend adapter-author API.
Its synchronous factory receives the bound planner, failure protocol, immutable manifest
and shared `validation` helpers. Use `validation.resource`, `idempotency`, `activity`,
`projection` and `record` to validate detached stored values; `json` enforces the same
finite JSON/byte/depth/node bounds. Storage-specific headers/physical keys must be checked
before removing them. Validate full idempotency rows before logical expiry. `record`
derives and validates the registered flat value's key and owner; do not invent hidden
fields that can collide with business schema fields.
Implement every `WorkflowStorage` port: command scope/time factories, validated resource
reads, keyset queries, registered auxiliary reads, monotonic failure CAS/history/projection/
create-only outbox transactions, and processing/collection markers. Missing services reject.

Command stores must consume their bound planner's opaque plan and enforce all conditions
atomically. Failure stores must use the provided protocol's parsing, projection and history
checks and commit any replay outbox event with the history. Reads used for replay/CAS are
strong. Marker `check` returns only `processed`, `available` or `full`; `write` records actual
completion, applies seven-day expiry and must not evict live work. Memory uses fingerprints
to reject observed transport-ID reuse. Store errors use structured runtime errors and
must never expose raw SDK responses or turn corrupt data into a cache miss.

The manifest is deeply frozen and function-free. Its hash covers declaration names,
command roles/emissions, versions, subscriptions, policies and numeric bounds, not schema
or function bodies. It is configuration identity, not an authentication secret or proof of
equivalent code; deployment artifacts need their own digests. The complete memory adapter
is shipped here; `@jawstack/aws-runtime` now ships `createDynamoWorkflow` against these
same contracts. Its `createWorkflowSqsHandlers` adds strict whole-batch transport binding;
the explicit `/local` subpath supplies guarded clients and owned-table startup.

`getWorkflowManifest(definition)` checks that a declaration was produced by this core
instance before returning its immutable manifest. Adapter configuration may use
`copyWorkflowJson(value, maximumBytes?)` for the same detached finite JSON/depth/node/byte
checks without constructing storage. Neither helper performs I/O or grants authorization.
