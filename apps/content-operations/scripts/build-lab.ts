import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

export async function buildLab(): Promise<void> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/aws/spine.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("Lambda build produced no output.");
  await mkdir(`${root}/dist`, { recursive: true });
  await writeFile(`${root}/dist/spine.zip`, zipSync({ "index.mjs": output.contents }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildLab();
