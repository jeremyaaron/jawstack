# Quickstart

This guide runs JawStack locally and verifies that the generated app can typecheck, test, build, synthesize CDK, and pass `jawstack doctor`.

## Prerequisites

- Node.js 22 or newer
- pnpm 10 or newer

From the repository:

```sh
nvm use
pnpm install
```

## Run The Demo App

Start the local API:

```sh
pnpm dev:api
```

In another terminal, start the web app:

```sh
pnpm dev:web
```

Open `http://127.0.0.1:4316`.

The local API uses in-memory persistence. It exercises the same command model as the AWS runtime, but it is not an AWS emulator.

## Verify The Workspace

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm pkg:check
pnpm verify:generated
```

`pnpm verify:generated` creates a temporary app, installs it offline, runs typecheck/test/build, builds Lambda assets, synthesizes CDK, and runs `jawstack doctor`.

## Generate A Local App

Until the package is published, build and run the local generator:

```sh
pnpm --filter create-jawstack run build
node packages/create-jawstack/dist/cli.js ../my-jawstack-app --local-package-root "$PWD"
cd ../my-jawstack-app
pnpm install
```

Verify the generated app:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm doctor
pnpm build:aws
pnpm synth
```

Run it locally:

```sh
pnpm dev:api
pnpm dev:web
```

When `create-jawstack` is published, use:

```sh
npm create jawstack@latest my-jawstack-app
```
