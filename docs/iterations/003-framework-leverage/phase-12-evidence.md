# Phase 12 Evidence

Status: complete. Final-source clean release, memory/HTTP/CLI checks and actual local
happy-path proof passed. No commit, publication, version bump, remote dispatch or real AWS deployment.

Base: `1932da69e10bd1ab7b235ecb6135057b506ec9fe`.

## Implementation

Private [Report Runs](../../../apps/report-runs/README.md) is an independent headless consumer.
It uses the full public memory/local factories, shared delivery/operations and outbox/SQS
adapters; its only worker logic is deterministic inventory calculation, strong business
authority checks and internal atomic completion. No command/transaction compiler, pump,
failure store, collector, replay scheduling or provider algorithm was copied.

It includes strict normalized inventory, stored canonical bytes/digests, requester/operator
fixtures, bounded loopback HTTP, all five CLI commands, explicit seed and startup, actual
Lambda archives, finite private lab data and opt-in CDK synthesis. No production fault
environment reader or fault-control route is present. Runtime imports and built Lambda
graphs contain no Content or private/deep framework imports.

One additive framework hook change gives backend replay eligibility a
detached frozen `original` fact alongside the summary/auth, so immutable digest eligibility
can be checked without implementing another ledger reader. Inspection/HTTP summaries are
unchanged; root authorization and read-only hook rules remain enforced.

Actual Lambda startup exposed emulator metadata not covered by the shared transport guard.
Reviewed allowances remain Lambda-only, behind validated dummy-account invocation identity,
matching function name and fixed loopback Runtime API context where applicable. SDK clients
still use explicit `test/test`, `us-east-1`, fixed service destinations and the final HTTP
destination guard. No metadata/credential-provider requests are made. Real credentials,
host inheritance, alternate endpoints and unreviewed settings still fail before SDK use.
Diagnostics disclose at most sixteen bounded AWS setting names, never values. See the
[public local contract](../../../packages/aws-runtime/local.md).

The lockfile adds only the new private importer; existing importers/resolutions/snapshots
remain unchanged. Frozen PRD/TDD, baseline, inventory and task fixtures are not edited.

## Clean Verification

Node 24.16.0 / pnpm 10.21.0. Final verification uses fresh clone
`/var/folders/xy/qddyrj19649dglvkkkbn1r6c0000gn/T/jawstack-iteration3-phase12-final-WTjhuW`,
overlaid with Git-visible source only. No ignored dependencies/builds, tokens, manifests,
review data or browser artifacts were copied. Frozen install precedes `pnpm verify:release`,
with tests before package builds. The earlier clean run also passed before the final
proof-only refinement requiring specific authorization denial rather than any client error.

Both clean runs passed all 1,411 workspace tests: core 354, AWS runtime 283, CDK 73,
Angular 44, CLI 20, generator 7, private lab 81, Work Requests 2, Content 509 and Report 38.
Eleven Node tooling tests and one frozen compatibility test bring the primary total to
1,423, excluding the generated fixture's two tests.

| Gate                              | Result                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Format/typecheck/lint/build       | Passed, including package declarations and the new private app.                                     |
| Browser package boundary          | 329 Angular modules, zero server imports.                                                           |
| Package guard/doctor              | Zero findings; no new suppressions.                                                                 |
| Generated consumer/package checks | Lint/typecheck/tests/build/synth/doctor and six package dry runs passed.                            |
| Actual Report synthesis           | Public recoverable-workflow construct and all named entrypoints synthesized locally; no deployment. |

Known prebuild CLI-bin, browser externalization/timing, color-environment and CDK flag
notices remain nonblocking. This is not a claim that every dependency/tool emits no notices.

Report tests cover canonical golden bytes/digest, NFC/supplementary Unicode, malformed
Unicode/control characters, bounds/coercion/duplicates, request/worker authority, replay,
lost acknowledgements, eight-day marker expiry and concurrent duplicate deliveries.
HTTP/CLI checks exercise every command, exact fixture boundaries, filters/cursors, actual
subprocess success/failure, non-overwriting verified export, bounded ingress/admission,
dependency-error sanitization, body deadlines and abort/close. Tests use observed HTTP
handshakes rather than short admission sleeps.

Bundle tests build/unpack/import all four archives under hostile inherited credentials,
check import purity and reject Content/private-tooling runtime graphs. CDK synthesis uses
the public recoverable-workflow construct; its API/sweeper assets are synthesis-only, not
SDK-lab resources. Frozen A/B readiness checks passed without executing new exercises.

All 28 changed/new non-Markdown files match the final clone. SHA-256 of the sorted
`[path, fileSha256]` list, serialized as JSON without a trailing LF:
`75901695877714ae8ce2bea0f4b5480ac53a59c08d8abfd43b4e5af31420c432`.
Subsequent status/evidence edits are Markdown only.

Post-gate review startup on loopback 4347 used the explicit ordinary memory seed and shared
managed driver. Documented `pnpm --silent` CLI request/status/result commands produced
machine-readable stdout, reached version two and exported bytes matching the stored digest.
Final documentation formatting and seven updated relative-link targets passed.

## Actual Local Proof

Disposable schema-2 lab `phase12k` passed from `2026-11-03T23:22:07.677Z` through
`2026-11-03T23:22:20.251Z` (12,574 ms), after the earlier clean release run. It uses the
unchanged pinned ARM64 LocalStack image and the explicitly selected existing ignored token
file with its user-attested Hobby setting. There was no token copy, environment dump,
host worker invocation, host pump, clock advance or real AWS access.

Profile hash:
`fa9f95403212acfce2cc44c4e7ddf743978cdef80d7b27cf230a3635b3c34776`.

| Archive   | SHA-256                                                            |
| --------- | ------------------------------------------------------------------ |
| outbox    | `13ce782acdfc1f3e6f812bcb7ca69b09cdb82ac9f83ebbb2470a831327fc5d18` |
| worker    | `28ea55a5b6fd7fd42257bc298fe05aa60f91e0811411cd5310b9e82e1edbf74a` |
| collector | `1762bc176feedbc2af1345abd81e52fbf5874288d187a0e4703eb2460911c249` |
| api       | `a23984ae1db2d3d01c3be272e64fd1b1b3423b244c7b4301ac1ccac54ee5509f` |

Only dispatcher/worker/collector are deployed by the finite SDK lab. Both clean
clones rebuilt identical bytes for every archive, including the synthesis-only API asset.

- Two ordinary, non-overwriting seed commands and a fresh HTTP request completed through
  the actual transaction/stream/bus/source-queue/Lambda path, using external workers.
- The requested report reached version two, with one completion activity and a strongly
  read successful worker marker. Verified stored HTTP bytes and CLI export matched its digest.
- Equivalent request replay retained the complete original response and trace values;
  comparison checks structural equality, not DynamoDB map property order.
- The other requester received the specific `auth.forbidden` result. An arbitrary SDK or
  network failure cannot satisfy that assertion. Operator failure inspection was empty.
- Timeout 30 seconds, concurrency two, batch one, visibility 180 seconds and three receives
  were unchanged. No S3 bucket or Scheduler resource was provisioned.
- Owned teardown confirmed zero emulator containers, warm Lambda containers and networks;
  manifest/routing/lock files were removed and images retained. Existing Content review
  servers and the version-three draft fixture were not reset or restarted.

Earlier attempts are not counted as passes. Labs `phase12`, `phase12b`, `phase12c`,
`phase12d`, `phase12f` and `phase12h` failed the strict startup environment guard; their
sanitized failure evidence and successful teardown records remain ignored locally.
`phase12e`/`phase12g` were seed-only diagnostic runs, followed by owned teardown.
`phase12i` reached real workers but failed its earlier proof assertions; that failed
record is retained. `phase12j` passed before tightening the denial assertion; `phase12k`
is the final-source acceptance result. No receive, visibility or proof deadline was raised
to turn a failed run into a pass.

Sanitized local artifacts and SHA-256:

| Artifact                                                      | SHA-256                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `/tmp/jawstack-phase12-final-install.log`                     | `9875ba12cdfef23d51f07f077c0599cc2389a79a897132ef181d1623b8a10a40` |
| `/tmp/jawstack-phase12-final-release.log`                     | `49b95dbe31b7efb74f474a64c26832594d24a66ed8c977e64288b5f8d4ab22ab` |
| `/tmp/jawstack-phase12k-up.log`                               | `ef102b0ee5f005b627a3da87f9427d566b1718d1f0e47d9e21d88b10991ca162` |
| `/tmp/jawstack-phase12k-provision.log`                        | `df9160366b82305f93291957b455a575c17f479bf13cc34a57bd1e86bac50524` |
| `/tmp/jawstack-phase12k-live.log`                             | `8f1cd6e3b0f969a1c60237f915d4709e31d390f8f2925cc2e0ef002ae205deb6` |
| Ignored `apps/report-runs/.localstack/phase12k-evidence.json` | `9f49320a652301c3394be4676ed9367e95797ba87f36531fe19d267164649905` |

## Remaining Gates

Installed-tarball acceptance, the full Report fault/reset matrix and final cross-consumer/CI
integration remain Phase 13. Final paired post-extraction exercises and the whole-consumer
audit remain unfinished. The last selected Content count is still 1,589 -> 948 (40.3%
retirement), not the final 50% target; adding Report does not enlarge the frozen denominator.
Content browser and full live failure/reset gates were not rerun in Phase 12; its UI did not change.
Local emulator success does not establish real-AWS IAM enforcement or production readiness.
