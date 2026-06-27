# **APP_TITLE**

Generated JawStack Work Requests app.

## Local Development

Install dependencies:

```sh
pnpm install
```

Run the API in one terminal:

```sh
pnpm dev:api
```

Run the Angular web app in another terminal:

```sh
pnpm dev:web
```

Open `http://127.0.0.1:4316`. The web app proxies `/api` to the local API server on `http://127.0.0.1:4317`.

## Verify

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm doctor
pnpm build:aws
pnpm synth
```

## Deploy Dev

Configure AWS credentials and region, then run:

```sh
pnpm doctor:deploy
pnpm deploy:dev
pnpm smoke:dev
pnpm destroy:dev
```

The dev stack creates real AWS resources. Destroy it when you are done.
