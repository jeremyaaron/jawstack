# Phase 11 Delivery Migration Ledger

The frozen inventory, baseline, task packets and compatibility fixture are unchanged.
[phase-11-inventory.json](phase-11-inventory.json) is a separate working post inventory.

| Retired App Algorithm                                                 | Current Owner / App Responsibility                                                                                          |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Failure history, replay envelope, key/fingerprint and CAS invariants  | Owned workflow failure protocol; browser DTO validation remains app-owned.                                                  |
| Memory failure/projection/replay publication                          | Shared memory failure store using the command persistence lock and backing maps.                                            |
| Dynamo failure validation/transaction/error classification            | Public Dynamo workflow storage; explicit borrowed client/table binding.                                                     |
| Collection/replay/authorization/update/retry/completion state machine | Shared failure service; Content retains editor authorization, publication reconciliation and editor-only publication retry. |
| Memory jobs/cursor/retry/marker/terminal collection loop              | Shared pump, delivery and markers; the existing HTTP loop remains the only managed driver.                                  |
| SQS whole-batch validation, marker ordering and acknowledgement       | Shared SQS binding and delivery; guarded local entrypoints bind domain handlers.                                            |
| Hand-built CDK collectors                                             | Opt-in recoverable workers; Content retains object/job grants and environment bindings.                                     |
| Independently selected local subscriptions                            | Workflow manifest-derived local profile; physical function/queue names remain unchanged.                                    |

`workers.execute` binds only business handlers. Its direct `handle` facade remains for
domain tests and existing internal callers, delegating canonical parsing/recovery methods;
production transports bind `execute`. There is no parallel ledger or processing loop.
Small store/pump/HTTP DTO facades preserve existing callers without implementing their
own retry, CAS, admission, marker eviction or acknowledgement algorithms.

The original editor/reconciler exclusions map to `authorizeContentOperations` and
`createPublicationReconciler/reconcile`; their integration and wrapper still count.
The moved event identity policy counts in full, conservatively including previously
excluded domain predicates. Replacing bindings in memory, synthesis, SQS, CDK and the
manifest-derived profile count, not just the old selected files. Browser failure DTOs
still count. No exclusion was broadened and the denominator remains 1,589 token-lines.

Current measurement and gate outcomes are recorded in [Phase 11 evidence](../phase-11-evidence.md).
The final whole-consumer audit and paired post-extraction exercises remain Phases 13-14;
this migration alone is not an agent-speed or final leverage verdict.

New public adapter composition entries expose existing shared implementations, not a
second family of protocols. This is additional API/concept burden: the complete workflow
factories remain the recommended default for new consumers. Content preserves its
already guarded local client/lifecycle composition rather than opening another client pool.
