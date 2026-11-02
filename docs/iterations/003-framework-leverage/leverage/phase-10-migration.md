# Phase 10 Command Migration Ledger

The frozen `inventory.json`, `baseline.json`, task packets and compatibility fixture are
unchanged. [phase-10-inventory.json](phase-10-inventory.json) is a separate working post
inventory, not a replacement baseline or final leverage verdict.

| Retired App Algorithm                                                                  | Current Owner / Remaining App Responsibility                                                                 |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Dispatch capture/scope/time/winner lookup and pinned replay                            | Public `createWorkflowCommandDispatch`; Content retains its live claim-result validator.                     |
| Transaction projection normalization, expiry replacement, duplicate/action/byte bounds | Shared owned workflow planner and Dynamo compiler; Content declares records and pure contributions.          |
| Memory lock, staged collection copies and atomic publication                           | `createMemoryWorkflowPersistence`; Content retains domain notification/job stores on the same backing store. |
| Dynamo scoped reads, transaction construction/send and cancellation classification     | `createDynamoWorkflowStorage`; Content supplies an explicit client/table/source.                             |

Domain receipt schema/key/value construction and publication-transition/attempt policy
remain app-owned. The original `receiptSchema` and `operationKey` exclusions stay at those
symbols. The original excluded `prepareTransaction/attempts` invocation maps to
`contributeContentCommand/attempts`; `prepareTransaction/parsed` receipt-value construction
maps to `contributeContentCommand/receiptValue`. Record registration and create calls still
count. No domain exclusion has been broadened.

The new `application/workflow.ts` counts in full, conservatively including its domain
metadata and fact-validation integration. Explicit new binding sites in runtime, API,
worker, job and synthesis composition also count, even outside the old selected spans.
Other selected recovery, delivery, pump and wire modules remain counted and unmigrated.
The test-only `test/support/command-plan.ts` views actual shared plans/compiled SDK items;
it is not an alternate runtime/compiler and no production module imports it.

Run with the same token-line counter:

```sh
pnpm leverage:measure snapshot --spec docs/iterations/003-framework-leverage/leverage/phase-10-inventory.json
```

Current working count: **1,589 -> 1,370 protocol token-lines (-219)**; separate lab remains
**443**. The frozen denominator is still 1,589, not the post count. This is not the final
whole-consumer audit or a passing 50% gate; Phase 11 still must retire delivery/recovery
machinery. No paired post exercise or agent-speed claim is made.

Framework growth from Phase 9: core **6,298 -> 6,313**, AWS runtime **3,082 -> 3,099**;
CDK remains **1,028**, private lab **2,187**. Five existing implementation functions become
public adapter-author entries, plus `WorkflowPersistenceFactory`: core storage-spec,
dispatch and memory-persistence composition; AWS storage and owned-plan compilation.
This API/concept growth is disclosed, not hidden by relocating app code. The complete
workflow factories remain the recommended default for a new consumer.
