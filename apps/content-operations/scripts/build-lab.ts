import { build } from "esbuild";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

export async function buildLab(): Promise<void> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  await mkdir(`${root}/dist`, { recursive: true });
  for (const entry of ["spine", "publication", "jobs", "recovery"]) {
    const result = await build({
      absWorkingDir: root,
      entryPoints: [`src/aws/${entry}.ts`],
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
    const temp = `${root}/dist/.${entry}-${randomUUID()}.zip`;
    try {
      await writeFile(temp, zipSync({ "index.mjs": output.contents }), { flag: "wx" });
      await rename(temp, `${root}/dist/${entry}.zip`);
    } finally {
      await rm(temp, { force: true });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildLab();
