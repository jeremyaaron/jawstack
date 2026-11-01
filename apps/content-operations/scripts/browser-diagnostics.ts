import { appendFile, lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export async function inspectDiagnostics(
  paths: string[],
  limits = { files: 300, bytes: 100 * 1024 * 1024 },
) {
  let files = 0;
  let bytes = 0;
  let entries = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    if (++entries > 500 || depth > 8) throw new Error("Diagnostic traversal budget exceeded.");
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("Diagnostic symlinks are not allowed.");
    if (stat.isDirectory()) {
      for await (const entry of await opendir(path)) await visit(join(path, entry.name), depth + 1);
    } else if (stat.isFile()) {
      files++;
      bytes += stat.size;
      if (files > limits.files || bytes > limits.bytes)
        throw new Error("Diagnostic artifact budget exceeded.");
    } else throw new Error("Unsupported diagnostic file kind.");
  };
  for (const path of paths) await visit(path, 0);
  return { files, bytes };
}
async function main() {
  const runtime = process.argv[2];
  if (!["memory", "localstack"].includes(runtime ?? ""))
    throw new Error("Select diagnostic runtime.");
  const paths = [
    `test-results/${runtime}`,
    `test-results/${runtime}-results.json`,
    "dist/web/browser-boundary.json",
    ...(runtime === "localstack" ? ["test-results/localstack-evidence.json"] : []),
  ];
  const result = await inspectDiagnostics(
    paths.map((path) => fileURLToPath(new URL(`../${path}`, import.meta.url))),
  );
  console.log(JSON.stringify({ status: "within-budget", ...result }));
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, "within-budget=true\n");
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  void main().catch(() => {
    console.error(
      "Diagnostic upload refused: invalid runtime, unsafe path, or exceeded 300-file/100-MiB budget.",
    );
    process.exitCode = 1;
  });
