import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hash, packet, root, safePath } from "./measure-leverage.mjs";

export function exerciseOptions(args, base = root) {
  let task,
    adapter,
    check = false,
    capture = false;
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === "--check") check = true;
    else if (flag === "--capture") capture = true;
    else if (flag === "--task" || flag === "--adapter") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value: ${flag}`);
      if (flag === "--task") task = value;
      else adapter = value;
    } else throw new Error(`Unknown option: ${flag}`);
  }
  if (!["a", "b", "compat"].includes(task)) throw new Error("Use --task a|b|compat.");
  if (task === "compat" && adapter)
    throw new Error("Compatibility capture does not use a task adapter.");
  if (capture && (task !== "compat" || check))
    throw new Error("--capture is only for an explicit compat run.");
  if (adapter) {
    if (!/\.ts$/.test(adapter))
      throw new Error("The thin candidate adapter must be a TypeScript file.");
    adapter = realpathSync(safePath(base, adapter));
    if (!adapter.includes("/apps/content-operations/test/"))
      throw new Error("Candidate adapter must live under apps/content-operations/test/.");
  }
  if (!check && task !== "compat" && !adapter)
    throw new Error(
      "Task not implemented: supply --adapter apps/content-operations/test/leverage-adapter.ts.",
    );
  return { task, adapter, check, capture };
}

export function checkPacket(base, task, capture = false) {
  const files = [
    "contracts.ts",
    "candidate.d.ts",
    "vitest.config.ts",
    task === "compat" ? "compatibility.acceptance.ts" : `task-${task}.md`,
    task === "compat" ? "compatibility-input.ts" : `task-${task}.acceptance.ts`,
  ];
  const hashes = Object.fromEntries(
    [...files, ...(task === "compat" && !capture ? ["compatibility.json"] : [])].map((file) => {
      const path = `${packet}/${file}`;
      return [path, hash(readFileSync(safePath(base, path)))];
    }),
  );
  if (task !== "compat" && existsSync(resolve(base, packet, "baseline.json"))) {
    const baseline = JSON.parse(readFileSync(resolve(base, packet, "baseline.json"), "utf8"));
    for (const [path, actual] of Object.entries(hashes))
      if (baseline.inputHashes[path] !== actual)
        throw new Error(`Frozen exercise packet changed: ${path}`);
  }
  return { task, packetReady: true, exerciseExecuted: false, hashes };
}

export function runExercise(args = process.argv.slice(2), base = root) {
  const options = exerciseOptions(args, base);
  const ready = checkPacket(base, options.task, options.capture);
  if (options.check) {
    console.log(JSON.stringify(ready, null, 2));
    return 0;
  }
  const start = new Date().toISOString();
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: base,
    encoding: "utf8",
  }).trim();
  console.log(
    JSON.stringify({
      task: options.task,
      sourceCommit,
      start,
      mode: "memory-and-sdk-double-not-live",
    }),
  );
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "content-operations",
      "exec",
      "vitest",
      "run",
      "--config",
      resolve(base, packet, "vitest.config.ts"),
    ],
    {
      cwd: base,
      stdio: "inherit",
      timeout: 300_000,
      env: {
        ...process.env,
        JAWSTACK_LEVERAGE_TASK: options.task,
        JAWSTACK_LEVERAGE_ADAPTER: options.adapter ?? "",
        JAWSTACK_CAPTURE_COMPAT: options.capture ? "1" : "",
      },
    },
  );
  const status = result.error ? 1 : (result.status ?? 1);
  console.log(
    JSON.stringify({
      task: options.task,
      start,
      end: new Date().toISOString(),
      result: status === 0 ? "passed" : "failed",
      error: result.error?.code ?? null,
    }),
  );
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runExercise();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
