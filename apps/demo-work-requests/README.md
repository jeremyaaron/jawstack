# Demo Work Requests

Local JawStack resource workflow demo using the workspace packages directly.

Run the API in one terminal:

```sh
pnpm dev:api
```

Run the Angular web app in another terminal:

```sh
pnpm dev:web
```

The web app runs on `http://127.0.0.1:4316` and proxies `/api` to the local API server on `http://127.0.0.1:4317`.
