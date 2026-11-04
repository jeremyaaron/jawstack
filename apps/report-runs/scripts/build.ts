import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { zipSync, strToU8 } from "fflate";
export const root = fileURLToPath(new URL("../", import.meta.url));
export async function buildReport() {
  await mkdir(root + "dist", { recursive: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/lambda.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    metafile: true,
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  });
  if (!result.outputFiles[0]) throw new Error("No Lambda bundle.");
  const inputs = Object.keys(result.metafile!.inputs);
  if (inputs.some((input) => /content-operations|tooling\/local-lab/.test(input)))
    throw new Error("Runtime bundle imports another consumer or private tooling.");
  const archives: Record<string, string> = {};
  for (const name of ["worker", "collector", "outbox", "api"]) {
    const exports = name === "outbox" ? "dispatcher, sweeper" : name;
    const path = root + "dist/" + name + ".zip";
    await writeFile(
      path,
      zipSync({
        "index.mjs": [
          strToU8(
            name === "outbox"
              ? 'export { dispatcher, sweeper } from "./runtime.mjs";\n'
              : "export { " + exports + ' as handler } from "./runtime.mjs";\n',
          ),
          { mtime: new Date(2000, 0, 1) },
        ],
        "runtime.mjs": [result.outputFiles[0].contents, { mtime: new Date(2000, 0, 1) }],
      }),
    );
    archives[name] = path;
  }
  return archives;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildReport();
