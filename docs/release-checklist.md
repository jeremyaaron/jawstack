# Release Checklist

The foundation is already merged/tagged `v0.0.1`; packages remain unpublished. Completing
an iteration is not release authorization. Do not retag that baseline, bump coordinated
versions, or publish merely to finish documentation. Iteration 2's
[outcome](iterations/002-content-operations/outcome.md#release-assessment) recommends
considering a separately reviewed `0.0.2` dogfood release, not preparing one implicitly.

## v0.0.1 Scope

Historically, `v0.0.1` tagged the first coherent JawStack baseline:

- Framework package boundaries exist.
- The Work Requests starter generates and verifies.
- Local run, AWS synth, and opt-in dev deploy smoke paths exist.
- Public docs describe the current product honestly.
- Package tarball dry-runs are clean.

## Pre-Merge Checks

Run:

```sh
nvm use
pnpm install --frozen-lockfile
pnpm build
pnpm verify:release
```

Use a clean checkout/install/build for final packaging acceptance. Run the complete
Content Operations memory browser suite separately; `verify:release` checks dependency
boundaries but does not launch Playwright. For iteration acceptance, run the explicitly
provisioned Hobby browser and full destructive integration/teardown gates sequentially;
follow the [consumer runbook](../apps/content-operations/README.md#verification). Record
actual results, failures, and exclusions rather than reusing an old pass.

PR/manual CI runs the credential-free gates; the Hobby workflow is manual, default-branch
only, and needs owner-configured environment protection/token/attestation. No push build
or remote success is implied. Audit local links, formatting, `git diff --check`, final
ownership cleanup, and tarball contents; leave changes for user review/commit.

Optional **Work Requests** AWS check, only with explicit approval for credentials/spend:

```sh
export AWS_PROFILE=jawstack-dev
export AWS_REGION=us-east-1
JAWSTACK_AWS_DEV_CONFIRM=deploy-dev pnpm aws:dev:smoke
```

This does not deploy Content Operations. Its CDK composition is local-only and synthesis-tested.

## Future Release

Agree on the public scope, coordinated package version, distribution channel, and release
notes after review. Re-run the relevant gates on the actual release candidate. Version
changes, merge, tag creation/push, registry publication, secrets, and cost-bearing AWS
checks each require deliberate authorization. Keep the original `v0.0.1` tag immutable.

## npm Publishing

Do not publish `v0.0.1` to npm.

For a later `0.0.x` dogfood publication, document how an installed user can meaningfully
adapt the Work Requests starter using the public composition contracts. Content Operations
is an example, not a newly generated template. No `0.1.0` readiness claim follows from it.

Before publishing:

- Add Changesets.
- Replace `workspace:*` release ranges during package versioning.
- Add a publish workflow with provenance.
- Run package dry-runs and inspect tarball contents.
- Verify `create-jawstack` generated dependencies resolve from npm.
- Exercise an independently installed consumer and record compatibility/breaking-change notes.
- Keep fixture-auth/local-only limitations explicit; package publication is not production certification.
