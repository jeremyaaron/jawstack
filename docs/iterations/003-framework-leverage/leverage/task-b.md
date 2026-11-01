# Task B: Recoverable Publication Receipt Consumer

This specification and its acceptance fixtures are identical for baseline and post sessions.
Use a different disposable checkout from task A. No prior solution patch/context, automatic
agent spawning, commits/pushes or shipping benchmark feature is authorized.

## Requested Change

Register `recordPublicationReceipt` for the existing `contentItem.published` fact. It
stores one immutable receipt using an ordinary internal `publicationReceipt` resource
command, deterministic business identity and normal atomic persistence. Do not use a
notification sink, marker-only deduplication or a new SDK-write protocol for the business
receipt. Use the fact's UUID `publicationId` as the deterministic receipt resource ID;
verify its stored content/publication/generation before accepting an equivalent delivery.
Use a stable command idempotency key derived from the UTF-8 JSON array
`[contentId, publicationId, generation]`. Persist these receipt fields:

```ts
{
  (contentId, publicationId, generation, sourceEventId, correlationId);
}
```

`sourceEventId` is the original publication fact, never a replay's transport event ID.
The first successful command commits one resource/version, one activity and one
`publicationReceipt.recorded` fact. Equivalent delivery after transport marker loss or
a crash after the business commit is a read-only business success, with no new version,
activity or fact. Preserve normal Content publication authority and publisher retry policy.

Register the consumer in the app's normal memory and AWS binding/composition paths, not
only a test switch. A transient dependency failure retries; terminal failure is durably
inspectable and authorized local editors can request bounded targeted recovery. Authors
cannot inspect/replay. Collection resumes if interrupted after its durable pending row.
Replay uses the existing failure/history/outbox protocol, not direct bus/queue publication.
Forged recovery envelopes reject even after transport markers have existed. Do not expose
the internal resource command through public editorial ingress.

Baseline may use all current public APIs and extend the existing app registration surfaces;
do not force a hand-written SDK implementation if an ordinary resource command suffices.
Post may add domain schema/command/handler/declaration/configuration only: no framework
internals changes or new implementations of extracted persistence/delivery/recovery logic.

## Neutral Acceptance Port

Implement `createPublicationHarness` in
`apps/content-operations/test/leverage-adapter.ts`, per `contracts.ts`/`candidate.d.ts`.
Use real app resource/consumer/recovery services. `original` is an actual committed
`contentItem.published` fact obtained by a normal create/submit/approve/publish path.
No fabricated success event or test-only alternative consumer implementation.

The suite runs against memory and narrow DynamoDB/marker SDK doubles; it explicitly does
not prove live retry timing, DLQ redrive or Lambda delivery. Those remain separate iteration
live gates. `deliver` calls the real registered worker delivery path, while `collect`,
`inspect` and `replay` delegate to the normal failure operations. `replay` returns the
actual durable outbox envelope for the stable request UUID. It must not construct one in
the test adapter. `clearMarkers` removes transport markers only, never business state.

Verification-only dependency/lifecycle hooks implement the three requested fault points:
`beforeBusiness` throws before receipt handling, `afterBusiness` throws after the real
receipt commit before processing marker/acknowledgement, and `afterRecord` interrupts
collection after the pending failure is durable. Faults persist until `setFault(null)`;
they must not appear as public routes or production environment readers.

`receipts()` reads actual resource state and projects only the five receipt fields.
`receiptEffects()` counts the actual publicationReceipt resources, activity and recorded
facts and their resource versions (one version-1 receipt), never cached expected results.
Use fixed clock/content ID from `fixture`, normal
identities, isolated stores and cleanup. Test doubles must reject unsupported SDK conditions.

```sh
pnpm leverage:exercise --task b --adapter apps/content-operations/test/leverage-adapter.ts
pnpm --filter content-operations test
```

The four neutral cases cover both adapters' transient retry/marker loss and interrupted
collection/authorization/replay/lost acknowledgement. Add focused domain/internal-ingress
tests and run app typecheck/lint. Do not edit the neutral packets to make a candidate pass.
