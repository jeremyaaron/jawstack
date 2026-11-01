import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkPacket, exerciseOptions } from "../leverage-exercise.mjs";
import { packet, root } from "../measure-leverage.mjs";

test("packet readiness does not claim an implemented feature or execute a model/service", () => {
  for (const task of ["a", "b", "compat"]) {
    const result = checkPacket(root, task);
    assert.equal(result.packetReady, true);
    assert.equal(result.exerciseExecuted, false);
    assert.ok(Object.keys(result.hashes).length >= 5);
  }
});

test("a task fixture changed after freezing is refused rather than silently accepted", () => {
  const base = mkdtempSync(join(tmpdir(), "jawstack-packet-"));
  try {
    const ready = checkPacket(root, "a");
    for (const path of Object.keys(ready.hashes)) {
      mkdirSync(dirname(join(base, path)), { recursive: true });
      cpSync(join(root, path), join(base, path));
    }
    writeFileSync(
      join(base, packet, "baseline.json"),
      JSON.stringify({ inputHashes: ready.hashes }),
    );
    assert.equal(checkPacket(base, "a").packetReady, true);
    appendFileSync(join(base, packet, "task-a.acceptance.ts"), "\n// changed fixture\n");
    assert.throws(() => checkPacket(base, "a"), /Frozen exercise packet changed/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("missing task/adapter and unknown or contradictory flags fail before running tests", () => {
  assert.throws(() => exerciseOptions([]), /task/);
  assert.throws(() => exerciseOptions(["--task", "a"]), /Task not implemented/);
  assert.throws(() => exerciseOptions(["--task", "a", "--capture"]), /compat run/);
  assert.throws(() => exerciseOptions(["--task", "compat", "--check", "--capture"]), /compat run/);
  assert.throws(() => exerciseOptions(["--task", "a", "--check", "--check"]), /Duplicate/);
  assert.throws(() => exerciseOptions(["--task", "unknown"]), /task/);
  assert.throws(() => exerciseOptions(["--task", "a", "--wat"]), /Unknown/);
  assert.throws(() => exerciseOptions(["--task", "a", "--adapter"]), /Missing value/);
  assert.throws(() => exerciseOptions(["--task", "a", "--adapter", "../outside.ts"]), /traversal/);
  assert.deepEqual(exerciseOptions(["--task", "a", "--check"]), {
    task: "a",
    check: true,
    capture: false,
    adapter: undefined,
  });
});

test("CLI reports readiness without spawning candidate tests, and missing adapter exits nonzero", () => {
  const checked = spawnSync(
    process.execPath,
    ["scripts/leverage-exercise.mjs", "--task", "a", "--check"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).exerciseExecuted, false);
  const missing = spawnSync(process.execPath, ["scripts/leverage-exercise.mjs", "--task", "b"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Task not implemented/);
  assert.doesNotMatch(missing.stdout, /RUN|passed/);
});
