import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tokenLines,
  selectSpan,
  inventory,
  compareSnapshots,
  summarizeSession,
  safePath,
  main,
} from "../measure-leverage.mjs";

test("scanner counts physical token lines once, excluding trivia and overlapping spans", () => {
  const text =
    "// ignored\nconst a = 1; /* comment */\n/* multiline\n comment */\n\nconst b = 2;\n";
  assert.deepEqual(tokenLines(text).lines, [2, 6]);
  assert.deepEqual(
    tokenLines(text, [
      { start: 0, end: text.length },
      { start: 0, end: text.length },
    ]).lines,
    [2, 6],
  );
  assert.deepEqual(tokenLines(text, undefined, [selectSpan(text, { symbol: "b" })]).lines, [2, 6]);
});

test("contextual regex/template/JSX text is not misinterpreted as comments", () => {
  const text =
    "const regex = /https?:\\/\\//;\nconst value = `first\n/*literal*/\n${1}\n//literal\n`;\n";
  assert.deepEqual(tokenLines(text).lines, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(tokenLines("const el = <p>/*text*/</p>;", undefined, [], "a.tsx").lines, [1]);
});

test("multiline domain subtree exclusion retains shared lines and generic sibling", () => {
  const text =
    "function factory() {\n  const domain = () => {\n    return 1;\n  };\n  return 2;\n}\n";
  const span = selectSpan(text, { symbol: "factory/domain" });
  const result = tokenLines(text, [selectSpan(text, { symbol: "factory" })], [span]);
  assert.deepEqual(result.lines, [1, 2, 4, 5, 6]);
  assert.equal(span.startLine, 2);
  assert.equal(span.endLine, 4);
  assert.match(span.sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => selectSpan(text, { symbol: "missing" }), /Missing AST symbol/);
});

test("selectors fail closed on ambiguity and syntax errors", () => {
  assert.throws(
    () => selectSpan("if (a) {} if (a) {}", { kind: "IfStatement", contains: "a" }),
    /got 2/,
  );
  assert.throws(() => tokenLines("const = ;"), /Invalid TypeScript/);
  assert.throws(() => selectSpan("const a = 1;", {}), /Incomplete AST/);
  assert.throws(() => main(["verify", "unexpected"]), /Usage/);
});

test("inventory includes hashes and refuses duplicates, traversal and escaping symlinks", () => {
  const base = mkdtempSync(join(tmpdir(), "jawstack-count-"));
  try {
    writeFileSync(join(base, "a.ts"), "const a = 1;\n");
    mkdirSync(join(base, "apps/content-operations/src"), { recursive: true });
    const path = "apps/content-operations/src/a.ts";
    writeFileSync(join(base, path), "const a = 1;\nconst b = 2;\n");
    const entry = {
      path,
      include: [{ symbol: "$file" }],
      classification: "selected-protocol",
      reason: "test",
    };
    const result = inventory(base, [entry]);
    assert.equal(result[0].tokenLines, 2);
    assert.match(result[0].sourceSha256, /^[a-f0-9]{64}$/);
    assert.throws(() => inventory(base, [entry, entry]), /Duplicate/);
    assert.throws(
      () => inventory(base, [{ ...entry, include: [{ symbol: "a" }], exclude: [{ symbol: "b" }] }]),
      /outside selected/,
    );
    assert.throws(
      () => inventory(base, [{ path: "a.ts", classification: "not-runtime" }]),
      /Invalid classified/,
    );
    assert.throws(() => safePath(base, "../outside"), /traversal/);
    symlinkSync(import.meta.filename, join(base, "outside.ts"));
    assert.throws(() => safePath(base, "outside.ts"), /symlink/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("overlapping waits are unioned, failed attempts retained and over-budget work disclosed", () => {
  const input = {
    schemaVersion: 1,
    snapshot: "baseline",
    task: "a",
    result: "failed",
    modelLabel: "test-only",
    sourceCommit: "test-only",
    tokens: null,
    startedAt: "2026-11-01T12:00:00Z",
    endedAt: "2026-11-01T12:40:00Z",
    waits: [
      { kind: "install", startedAt: "2026-11-01T12:00:00Z", endedAt: "2026-11-01T12:02:00Z" },
      { kind: "install", startedAt: "2026-11-01T12:01:00Z", endedAt: "2026-11-01T12:03:00Z" },
    ],
  };
  const result = summarizeSession(input);
  assert.equal(result.excludedInstallMs, 180_000);
  assert.equal(result.activeElapsedMs, 2_220_000);
  assert.equal(result.withinBudget, false);
  assert.equal(result.result, "failed");
  assert.equal(result.tokens, "unavailable");
  assert.throws(() => summarizeSession({ ...input, tokens: "estimated" }), /actual client/);
  assert.throws(
    () =>
      summarizeSession({
        ...input,
        waits: [{ kind: "test", startedAt: input.startedAt, endedAt: input.endedAt }],
      }),
    /install wait/,
  );
});

test("half reduction is necessary, not a fabricated leverage verdict", () => {
  const baseline = { protocolTokenLines: 100 };
  const post = {
    protocolTokenLines: 50,
    audit: { reviewed: true, allConsumerPathsReviewed: true },
  };
  assert.equal(compareSnapshots(baseline, post).structuralGate, "pass");
  assert.match(compareSnapshots(baseline, post).leverageVerdict, /requires/);
  assert.equal(
    compareSnapshots(baseline, { ...post, protocolTokenLines: 51 }).structuralGate,
    "fail",
  );
  assert.throws(() => compareSnapshots(baseline, { protocolTokenLines: 0 }), /whole-consumer/);
  assert.throws(() => compareSnapshots({ protocolTokenLines: 0 }, post), /denominator/);
  assert.throws(
    () => compareSnapshots(baseline, { ...post, protocolTokenLines: -1 }),
    /Invalid post/,
  );
  assert.throws(
    () => compareSnapshots({ ...baseline, rules: { version: 1 } }, post),
    /rules differ/,
  );
});
