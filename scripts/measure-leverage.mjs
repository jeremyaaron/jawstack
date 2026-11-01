import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const packet = "docs/iterations/003-framework-leverage/leverage";
export const hash = (value) => createHash("sha256").update(value).digest("hex");
const read = (base, path) => readFileSync(safePath(base, path), "utf8");

export function safePath(base, path) {
  if (isAbsolute(path) || path.split(/[\\/]/).includes(".."))
    throw new Error("Expected a repository-relative path without traversal.");
  const target = resolve(base, path);
  const actual = realpathSync(target);
  if (relative(realpathSync(base), actual).startsWith("..") || isAbsolute(relative(base, actual)))
    throw new Error("Source symlink escapes the checkout.");
  return target;
}

function parse(text, path) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw new Error(`Invalid TypeScript: ${path}`);
  return source;
}

export function namedSpans(text, path = "source.ts") {
  const source = parse(text, path);
  const spans = new Map([["$file", { start: 0, end: text.length, kind: "SourceFile" }]]);
  const visit = (node, parent) => {
    let name;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isPropertyAssignment(node)
    )
      name =
        node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
          ? node.name.text
          : undefined;
    const key = name ? [...parent, name].join("/") : undefined;
    if (key) {
      spans.set(
        key,
        spans.has(key)
          ? null
          : {
              start: node.getStart(source),
              end: node.end,
              kind: ts.SyntaxKind[node.kind],
            },
      );
    }
    ts.forEachChild(node, (child) => visit(child, name ? [...parent, name] : parent));
  };
  ts.forEachChild(source, (child) => visit(child, []));
  return { source, spans };
}

export function selectSpan(text, selector, path = "source.ts") {
  const { source, spans } = namedSpans(text, path);
  let span;
  if (selector.symbol) {
    span = spans.get(selector.symbol);
    if (span === null) throw new Error(`Ambiguous AST symbol ${selector.symbol} in ${path}`);
  } else {
    if (!selector.kind || !selector.contains) throw new Error("Incomplete AST selector.");
    const matches = [];
    const visit = (node) => {
      if (
        ts.SyntaxKind[node.kind] === selector.kind &&
        node.getText(source).includes(selector.contains)
      )
        matches.push({ start: node.getStart(source), end: node.end, kind: selector.kind });
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (matches.length !== 1)
      throw new Error(`Expected one AST match in ${path}, got ${matches.length}.`);
    span = matches[0];
  }
  if (!span) throw new Error(`Missing AST symbol ${selector.symbol} in ${path}`);
  return {
    ...selector,
    ...span,
    startLine: source.getLineAndCharacterOfPosition(span.start).line + 1,
    endLine: source.getLineAndCharacterOfPosition(span.end - 1).line + 1,
    sha256: hash(text.slice(span.start, span.end)),
  };
}

export function tokenLines(
  text,
  included = [{ start: 0, end: text.length }],
  excluded = [],
  path = "source.ts",
) {
  const source = parse(text, path);
  // The parser supplies contextual token boundaries that a standalone scanner cannot infer.
  const contextual = new Map();
  const visit = (node) => {
    if (
      ts.isToken(node) &&
      (node.kind === ts.SyntaxKind.RegularExpressionLiteral ||
        node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
        node.kind === ts.SyntaxKind.TemplateHead ||
        node.kind === ts.SyntaxKind.TemplateMiddle ||
        node.kind === ts.SyntaxKind.TemplateTail ||
        node.kind === ts.SyntaxKind.JsxText ||
        node.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces)
    )
      contextual.set(node.getStart(source), node.end);
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, source.languageVariant, text);
  const lines = new Set();
  let tokens = 0;
  while (scanner.getTextPos() < text.length) {
    const kind = scanner.scan();
    const start = scanner.getTokenPos();
    let end = scanner.getTextPos();
    if (contextual.has(start)) {
      end = contextual.get(start);
      scanner.setTextPos(end);
    }
    if (
      kind === ts.SyntaxKind.EndOfFileToken ||
      (kind >= ts.SyntaxKind.FirstTriviaToken && kind <= ts.SyntaxKind.LastTriviaToken)
    )
      continue;
    let counted = false;
    for (const include of included) {
      for (let i = Math.max(start, include.start); i < Math.min(end, include.end); i++) {
        if (/\s/.test(text[i]) || excluded.some((range) => i >= range.start && i < range.end))
          continue;
        lines.add(source.getLineAndCharacterOfPosition(i).line + 1);
        counted = true;
      }
    }
    if (counted) tokens++;
  }
  return { lines: [...lines].sort((a, b) => a - b), tokens };
}

export function inventory(base, entries) {
  const paths = new Set();
  return entries.map((entry) => {
    if (
      !["selected-protocol", "separate-lab"].includes(entry.classification) ||
      !entry.reason ||
      !entry.path.startsWith("apps/content-operations/") ||
      /\/(test|tests|node_modules|dist|coverage|test-results|docs)\//.test(entry.path) ||
      !/\.[cm]?[tj]sx?$/.test(entry.path) ||
      !entry.include?.length
    )
      throw new Error("Invalid classified consumer inventory entry.");
    if (paths.has(entry.path)) throw new Error(`Duplicate inventory path: ${entry.path}`);
    paths.add(entry.path);
    const text = read(base, entry.path);
    const includes = entry.include.map((selector) => selectSpan(text, selector, entry.path));
    const excludes = (entry.exclude ?? []).map((selector) =>
      selectSpan(text, selector, entry.path),
    );
    for (const span of excludes)
      if (!includes.some((included) => span.start >= included.start && span.end <= included.end))
        throw new Error(`Excluded span is outside selected symbols: ${entry.path}`);
    const counted = tokenLines(text, includes, excludes, entry.path);
    return {
      path: entry.path,
      classification: entry.classification,
      reason: entry.reason,
      sourceSha256: hash(text),
      includes,
      excludes,
      tokenLines: counted.lines.length,
      tokens: counted.tokens,
      countedLines: counted.lines,
    };
  });
}

function walkSources(base, path) {
  return readdirSync(safePath(base, path), { withFileTypes: true })
    .flatMap((entry) => {
      const child = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${child}`);
      if (entry.isDirectory()) return walkSources(base, child);
      return /\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [child] : [];
    })
    .sort();
}

function frameworkSnapshot(base) {
  return readdirSync(safePath(base, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = `packages/${entry.name}`;
      const manifest = JSON.parse(read(base, `${directory}/package.json`));
      const sources = walkSources(base, `${directory}/src`).map((path) => {
        const text = read(base, path);
        return {
          path,
          sha256: hash(text),
          tokenLines: tokenLines(text, undefined, [], path).lines.length,
        };
      });
      const entrypoint = `${directory}/src/index.ts`;
      const source = parse(read(base, entrypoint), entrypoint);
      const exports = [];
      for (const statement of source.statements) {
        if (ts.isExportDeclaration(statement)) exports.push(statement.getText(source));
        else if (ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
          if (ts.isVariableStatement(statement))
            exports.push(
              ...statement.declarationList.declarations.map((d) => d.name.getText(source)),
            );
          else if (statement.name) exports.push(statement.name.getText(source));
        }
      }
      return {
        package: manifest.name,
        sourceTokenLines: sources.reduce((n, s) => n + s.tokenLines, 0),
        sources,
        packageExports: manifest.exports,
        declaredIndexExports: exports.sort(),
      };
    });
}

export function snapshot(base, spec, specPath = `${packet}/inventory.json`) {
  if (spec.schemaVersion !== 1) throw new Error("Unsupported inventory specification.");
  const files = inventory(base, spec.files);
  const hashes = Object.fromEntries(spec.inputs.map((path) => [path, hash(read(base, path))]));
  const applicationSources = walkSources(base, "apps/content-operations/src").map((path) => ({
    path,
    sha256: hash(read(base, path)),
  }));
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: base,
      encoding: "utf8",
    }).trim(),
    trackedPatchSha256: hash(execFileSync("git", ["diff", "HEAD", "--binary"], { cwd: base })),
    node: process.version,
    typescript: ts.version,
    pnpm: execFileSync("pnpm", ["--version"], { cwd: base, encoding: "utf8" }).trim(),
    gitStatus: execFileSync("git", ["status", "--short"], { cwd: base, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean),
    exerciseSettings: spec.exerciseSettings,
    rules: spec.rules,
    inputHashes: hashes,
    inventorySpecSha256: hash(read(base, specPath)),
    ...(spec.audit ? { audit: spec.audit } : {}),
    protocolTokenLines: files
      .filter((f) => f.classification === "selected-protocol")
      .reduce((n, f) => n + f.tokenLines, 0),
    separateLabTokenLines: files
      .filter((f) => f.classification === "separate-lab")
      .reduce((n, f) => n + f.tokenLines, 0),
    files,
    applicationSources,
    framework: frameworkSnapshot(base),
  };
}

export function verifyFrozen(base, frozen, spec) {
  if (
    frozen.schemaVersion !== 1 ||
    frozen.inventorySpecSha256 !== hash(read(base, `${packet}/inventory.json`))
  )
    throw new Error("Frozen inventory specification changed.");
  for (const [path, expected] of Object.entries(frozen.inputHashes))
    if (hash(read(base, path)) !== expected)
      throw new Error(`Frozen packet/input changed: ${path}`);
  const current = inventory(base, spec.files);
  for (const file of frozen.files) {
    const actual = current.find((candidate) => candidate.path === file.path);
    if (!actual || JSON.stringify(actual) !== JSON.stringify(file))
      throw new Error(`Frozen source/span/count changed: ${file.path}`);
  }
  const sources = walkSources(base, "apps/content-operations/src").map((path) => ({
    path,
    sha256: hash(read(base, path)),
  }));
  if (JSON.stringify(sources) !== JSON.stringify(frozen.applicationSources))
    throw new Error("Content runtime source set changed from the frozen baseline.");
  if (JSON.stringify(frameworkSnapshot(base)) !== JSON.stringify(frozen.framework))
    throw new Error("Framework runtime/export set changed from the frozen baseline.");
  return {
    verified: true,
    protocolTokenLines: frozen.protocolTokenLines,
    baselineCommit: frozen.sourceCommit,
  };
}

export function compareSnapshots(frozen, post) {
  if (!Number.isSafeInteger(frozen.protocolTokenLines) || frozen.protocolTokenLines <= 0)
    throw new Error("Empty or invalid baseline denominator.");
  if (!Number.isSafeInteger(post.protocolTokenLines) || post.protocolTokenLines < 0)
    throw new Error("Invalid post count.");
  if (JSON.stringify(frozen.rules) !== JSON.stringify(post.rules))
    throw new Error("Counting rules differ from the frozen baseline.");
  if (!post.audit || post.audit.reviewed !== true || !post.audit.allConsumerPathsReviewed)
    throw new Error(
      "Post inventory requires explicit whole-consumer review, including moved/generated replacements.",
    );
  const reduction = 1 - post.protocolTokenLines / frozen.protocolTokenLines;
  return {
    baseline: frozen.protocolTokenLines,
    post: post.protocolTokenLines,
    reduction,
    structuralGate: reduction >= 0.5 ? "pass" : "fail",
    leverageVerdict: "requires-paired-exercise-and-functional-evidence",
    framework: post.framework,
  };
}

export function summarizeSession(input) {
  const start = Date.parse(input.startedAt),
    end = Date.parse(input.endedAt);
  if (
    input.schemaVersion !== 1 ||
    !["baseline", "post"].includes(input.snapshot) ||
    !["a", "b"].includes(input.task) ||
    !["passed", "failed", "partial"].includes(input.result) ||
    !input.modelLabel ||
    !input.sourceCommit ||
    !Array.isArray(input.waits) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start
  )
    throw new Error("Incomplete or invalid session record.");
  const intervals = input.waits
    .map((wait) => {
      const from = Date.parse(wait.startedAt),
        to = Date.parse(wait.endedAt);
      if (
        wait.kind !== "install" ||
        !Number.isFinite(from) ||
        !Number.isFinite(to) ||
        from < start ||
        to > end ||
        to < from
      )
        throw new Error("Invalid bounded install wait.");
      return [from, to];
    })
    .sort((a, b) => a[0] - b[0]);
  const union = [];
  for (const interval of intervals) {
    const last = union.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else union.push([...interval]);
  }
  const excludedMs = union.reduce((n, [from, to]) => n + to - from, 0);
  const activeMs = end - start - excludedMs;
  if (input.tokens !== null && (!Number.isSafeInteger(input.tokens) || input.tokens < 0))
    throw new Error("Tokens must be actual client usage or null.");
  return {
    ...input,
    elapsedMs: end - start,
    excludedInstallMs: excludedMs,
    activeElapsedMs: activeMs,
    budget: { activeSeconds: 1800, installWaitSeconds: 300, serviceWaitSeconds: 0 },
    withinBudget: activeMs <= 1_800_000 && excludedMs <= 300_000,
    measurement: "visible elapsed minus union of install waits; not model thinking/CPU time",
    tokens: input.tokens ?? "unavailable",
  };
}

export function main(args = process.argv.slice(2), base = root) {
  const [mode, ...rest] = args;
  if (mode === "session") {
    if (rest.length !== 1) throw new Error("Usage: measure-leverage.mjs session RECORD.json");
    console.log(JSON.stringify(summarizeSession(JSON.parse(read(base, rest[0]))), null, 2));
    return;
  }
  if (mode === "compare") {
    if (rest.length !== 2) throw new Error("Usage: measure-leverage.mjs compare BASELINE POST");
    console.log(
      JSON.stringify(
        compareSnapshots(JSON.parse(read(base, rest[0])), JSON.parse(read(base, rest[1]))),
        null,
        2,
      ),
    );
    return;
  }
  let specPath = `${packet}/inventory.json`;
  if (mode === "snapshot" && rest.length === 2 && rest[0] === "--spec") specPath = rest[1];
  else if (!["freeze", "verify", "snapshot"].includes(mode) || rest.length)
    throw new Error(
      "Usage: measure-leverage.mjs freeze|verify|snapshot [--spec PATH] OR compare BASELINE POST OR session RECORD.json",
    );
  const spec = JSON.parse(read(base, specPath));
  const target = `${packet}/baseline.json`;
  if (mode === "verify") {
    console.log(JSON.stringify(verifyFrozen(base, JSON.parse(read(base, target)), spec), null, 2));
  } else {
    const result = snapshot(base, spec, specPath);
    if (mode === "freeze") {
      writeFileSync(resolve(base, target), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
      console.log(
        `Frozen ${result.protocolTokenLines} protocol token-lines; existing baselines are never overwritten.`,
      );
    } else console.log(JSON.stringify(result, null, 2));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
