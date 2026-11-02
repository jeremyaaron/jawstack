import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";
import { build } from "esbuild";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const core = fileURLToPath(new URL("../../core", import.meta.url));
const entry = `${core}/src/index.ts`;
const bare = builtinModules.filter((name) => !name.startsWith("node:"));
const external = [...bare, ...bare.map((name) => `node:${name}`)];

describe("legacy resource-only consumer tree shaking", () => {
  it.each(["source", "flattened"])(
    "does not retain workflow async context constructors from %s",
    async (mode) => {
      const compiled =
        mode === "flattened"
          ? await build({
              entryPoints: [entry],
              bundle: true,
              write: false,
              platform: "node",
              format: "esm",
              external: [...external, "zod"],
              logLevel: "silent",
            })
          : undefined;
      const result = await build({
        stdin: {
          contents:
            'import { workRequestResource } from "fixture-core"; export const resource = workRequestResource;',
          resolveDir: core,
          loader: "js",
        },
        bundle: true,
        write: false,
        platform: "browser",
        format: "esm",
        external,
        logLevel: "silent",
        plugins: [
          {
            name: "fixture-core",
            setup(builder) {
              builder.onResolve({ filter: /^fixture-core$/ }, () =>
                compiled
                  ? { path: "compiled-core", namespace: "compiled-fixture" }
                  : { path: entry },
              );
              builder.onLoad({ filter: /.*/, namespace: "compiled-fixture" }, () => ({
                contents: compiled!.outputFiles[0]!.text,
                resolveDir: core,
                loader: "js",
              }));
            },
          },
        ],
      });
      const code = result.outputFiles[0]!.text;
      expect(code).toContain("workRequest");
      const source = ts.createSourceFile(
        "bundle.js",
        code,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      const names = new Set<string>();
      for (const statement of source.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          !["async_hooks", "node:async_hooks"].includes(statement.moduleSpecifier.text)
        )
          continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings))
          for (const binding of bindings.elements)
            if ((binding.propertyName ?? binding.name).text === "AsyncLocalStorage")
              names.add(binding.name.text);
      }
      const retained: string[] = [];
      const visit = (node: ts.Node) => {
        if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          names.has(node.expression.text)
        )
          retained.push(node.getText(source));
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(retained).toEqual([]);
    },
  );
});
