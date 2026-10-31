# @jawstack/angular

Standalone Angular resource workflow components for JawStack applications.

This package contains:

- App shell, empty state, error panel, list, detail, form, command button/dialog, and activity timeline components.
- `provideJawStack` and `FetchJawStackApiClient` for generated apps.
- Runtime rendering based on JawStack resource metadata.
- Browser-safe presentation contracts and structured API errors.

Status: `0.0.1` dogfood baseline. Components are intentionally minimal and expected to change before `0.1.0`.

## Presentation Metadata

`ResourceUiDefinition` contains only `name`, `title`, scalar `state` metadata, `views`,
and a command map. Each `CommandUiDefinition` has `title`, `roles`, an input schema, and
the `create` flag. There is no executor, event declaration, worker, or schedule requirement.
All resource component inputs and `JawStackConfig.resources` use this structural contract.
Existing full core `ResourceDefinition` values remain assignable.

Keep shared inputs and UI metadata in a browser-safe module:

```ts
import { z } from "zod";
import type { ResourceUiDefinition } from "@jawstack/angular";

export const createInput = z.object({ title: z.string().min(1) });

export const contentUi = {
  name: "contentItem",
  title: "Content Items",
  state: {
    kind: "jawstack.state",
    fields: { title: { kind: "string", required: true, label: "Title" } },
  },
  views: {},
  commands: {
    create: { title: "Create content", roles: ["author"], input: createInput, create: true },
  },
} satisfies ResourceUiDefinition;
```

Pass this value to `provideJawStack` and resource components. Server resource factories
can import the same schema, but browsers should not import instantiated server resources
or decision factories. The structural type does not strip extra properties or sanitize a
full resource at runtime. Existing demo/template consumers retain their legacy full-resource
imports for compatibility; this phase does not migrate them. UI role checks are presentation
only; authorization must still run on the server.

## API Errors

`FetchJawStackApiClient` throws `JawStackApiError extends Error` for failed API responses.
Its constructor is `new JawStackApiError(message, { code, status, details?, correlationId? })`.
`code` is a string so application-specific codes are preserved; `status` is the actual HTTP
response status, `details` is the opaque server error detail, and `correlationId` comes from
`meta.correlationId` when provided. Existing `instanceof Error` and `.message` handling works.

```ts
import { JawStackApiError } from "@jawstack/angular";

try {
  await api.command(request);
} catch (error) {
  if (error instanceof JawStackApiError && error.status === 409) {
    // Preserve the user's draft and offer explicit conflict recovery.
  }
  throw error;
}
```

Legacy error messages without codes remain usable. Missing or malformed error fields on a
failed HTTP response fall back to `http.error`; a malformed successful envelope falls back
to `api.invalid_response`. Invalid JSON produces the same structured fallbacks without
including raw response text. A valid server error code is retained even if the server used
HTTP 200 incorrectly. Transport/body-stream failures and aborts remain their original errors,
because there may be no meaningful HTTP response to classify. Successful payloads, paths,
auth headers, and command/idempotency serialization are unchanged.

## Browser Boundary

Angular tests render list, detail, activity, form, command button, and dialog components with
presentation-only metadata, alongside regressions for existing complete definitions. A real
browser-targeted fixture build also checks the dependency graph: no Node builtins/HTTP shim,
core runtime, AWS SDK/runtime, or CDK modules may enter the bundle. The fixture uses Zod
schemas and retains all components; it does not require a server factory or fake `decide`.

`pnpm --filter @jawstack/angular test` checks the source boundary without a prior library
build. Every Angular library build runs the same check against the compiled package entrypoint;
`pnpm --filter @jawstack/angular verify:browser` repeats that check after a build. The check
uses [esbuild metafiles](https://esbuild.github.io/api/#metafile), writes no bundle to disk, and
is a dependency/build assertion, not a browser layout or full application acceptance test.
