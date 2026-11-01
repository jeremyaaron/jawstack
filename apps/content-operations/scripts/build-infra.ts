import { build } from "esbuild";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { zipSync, strToU8 } from "fflate";
import { infrastructureArtifacts } from "../src/infra/config";

export async function buildInfrastructure() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const dir = `${root}/dist/infra`;
  await mkdir(dir, { recursive: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/aws/synth/entrypoints.ts"],
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
  if (!output) throw new Error("No synthesis runtime bundle produced.");
  const paths = {} as Record<(typeof infrastructureArtifacts)[number], string>;
  for (const name of infrastructureArtifacts) {
    const exports =
      name === "outbox"
        ? "export { dispatcher, sweeper }"
        : `export { ${name === "scheduler" ? "scheduled" : name} as handler }`;
    const temp = `${dir}/.${name}-${randomUUID()}.zip`;
    const path = `${dir}/${name}.zip`;
    try {
      await writeFile(
        temp,
        zipSync({
          "index.mjs": [
            strToU8(`${exports} from "./runtime.mjs";\n`),
            { mtime: new Date(2000, 0, 1) },
          ],
          "runtime.mjs": [output.contents, { mtime: new Date(2000, 0, 1) }],
        }),
        { flag: "wx" },
      );
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
    paths[name] = path;
  }
  return paths;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildInfrastructure();
