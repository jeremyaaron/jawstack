import assert from "node:assert/strict";
import { log } from "node:console";
import { builtinModules } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
assert(
  args.length === 0 || (args.length === 1 && args[0] === "--source"),
  "Expected only optional --source.",
);
const mode = args[0] === "--source" ? "source" : "package";
const entry = mode === "source" ? "./src/index.ts" : "@jawstack/angular";
const builtins = new Set(builtinModules);

const result = await build({
  absWorkingDir: root,
  stdin: {
    contents: `
      import "@angular/compiler";
      import {
        provideJawStack, FetchJawStackApiClient, JawStackApiError,
        JsAppShellComponent, JsEmptyStateComponent, JsErrorPanelComponent, JsStatusBadgeComponent,
        JsResourceListComponent, JsResourceDetailComponent, JsResourceFormComponent,
        JsCommandButtonComponent, JsCommandDialogComponent, JsActivityTimelineComponent,
      } from ${JSON.stringify(entry)};
      import { contentUi } from "./test/fixtures/presentation.ts";
      export const providers = provideJawStack({ apiBaseUrl: "/api", resources: [contentUi] });
      export const components = [JsAppShellComponent, JsEmptyStateComponent, JsErrorPanelComponent,
        JsStatusBadgeComponent, JsResourceListComponent, JsResourceDetailComponent,
        JsResourceFormComponent, JsCommandButtonComponent, JsCommandDialogComponent,
        JsActivityTimelineComponent];
      export { contentUi, FetchJawStackApiClient, JawStackApiError };
    `,
    loader: "ts",
    resolveDir: root,
    sourcefile: "presentation-browser.ts",
  },
  platform: "browser",
  format: "esm",
  target: "es2022",
  bundle: true,
  write: false,
  metafile: true,
  tsconfig: join(root, "tsconfig.json"),
  logLevel: "silent",
  plugins: [
    {
      name: "presentation-only-boundary",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path }) => {
          if (
            builtins.has(path) ||
            path.startsWith("node:") ||
            /^@(?:aws-sdk|smithy)\//.test(path) ||
            /^@jawstack\/(?:core|aws-runtime|aws-cdk)(?:\/|$)/.test(path) ||
            /^(?:aws-cdk-lib|constructs)(?:\/|$)/.test(path) ||
            /(?:^|\/)browser-shims\//.test(path)
          ) {
            return { errors: [{ text: `Forbidden browser runtime import: ${path}` }] };
          }
          return undefined;
        });
      },
    },
  ],
});

const inputs = Object.keys(result.metafile.inputs);
assert(inputs.some((path) => path.endsWith("test/fixtures/presentation.ts")));
assert(inputs.some((path) => path.endsWith(mode === "source" ? "src/index.ts" : "dist/index.js")));
assert(
  !inputs.some((path) =>
    /(?:packages\/core\/src|browser-shims|node-http|aws-runtime|aws-cdk|@aws-sdk|@smithy)/.test(
      path,
    ),
  ),
);
const code = result.outputFiles[0]?.text ?? "";
assert(
  code.includes("js-resource-list") && code.includes("Approve content"),
  "The fixture must retain real components and command metadata.",
);
assert(
  result.metafile.outputs &&
    Object.values(result.metafile.outputs).every((output) => output.imports.length === 0),
  "Browser verification must not leave external runtime imports.",
);
log(
  JSON.stringify({
    status: "passed",
    mode,
    modules: inputs.length,
    bytes: code.length,
    serverImports: 0,
  }),
);
