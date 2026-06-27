# Release Checklist

This repository is prepared for a `v0.0.1` dogfood tag, not an npm publication.

## v0.0.1 Scope

`v0.0.1` is a Git tag for the first coherent JawStack baseline:

- Framework package boundaries exist.
- The Work Requests starter generates and verifies.
- Local run, AWS synth, and opt-in dev deploy smoke paths exist.
- Public docs describe the current product honestly.
- Package tarball dry-runs are clean.

## Pre-Merge Checks

Run:

```sh
nvm use
pnpm install
pnpm verify:release
```

Optional AWS check, only when credentials and spend are acceptable:

```sh
export AWS_PROFILE=jawstack-dev
export AWS_REGION=us-east-1
JAWSTACK_AWS_DEV_CONFIRM=deploy-dev pnpm aws:dev:smoke
```

## Tag

After merge to `main`:

```sh
git checkout main
git pull --ff-only
git tag v0.0.1
git push origin v0.0.1
```

## npm Publishing

Do not publish `v0.0.1` to npm.

The bar for npm publication is a later `0.0.x` or `0.1.0` where a user can generate and meaningfully adapt an app beyond the fixed Work Requests starter.

Before publishing:

- Add Changesets.
- Replace `workspace:*` release ranges during package versioning.
- Add a publish workflow with provenance.
- Run package dry-runs and inspect tarball contents.
- Verify `create-jawstack` generated dependencies resolve from npm.
