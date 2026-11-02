import { execFile } from "node:child_process";
import { readFile, writeFile, rm, access, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { inspectRuntimes, openLab, parseProfile, verifyArchives } from "../src/index";
import { dockerDouble, fixture, manifest, ownerId } from "./support";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
const setup = async () => {
  const f = await fixture();
  cleanups.push(f.clean);
  return f;
};
it("includes private tooling in every root gate but not in public dependency graphs", async () => {
  const root = new URL("../../../", import.meta.url);
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  for (const name of ["build", "typecheck", "test", "lint"])
    expect(pkg.scripts[name]).toContain("--filter './tooling/*'");
  expect(await readFile(new URL("pnpm-workspace.yaml", root), "utf8")).toContain('"tooling/*"');
  expect(
    JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).private,
  ).toBe(true);
  for (const name of await readdir(new URL("packages/", root))) {
    const manifest = JSON.parse(
      await readFile(new URL(`packages/${name}/package.json`, root), "utf8"),
    );
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ])
      expect(manifest[field] ?? {}).not.toHaveProperty("@jawstack/local-lab");
  }
  for (const name of await readdir(new URL("../src/", import.meta.url)))
    expect(await readFile(new URL(`../src/${name}`, import.meta.url), "utf8")).not.toMatch(
      /content-operations|CONTENT_OPS|["'][^"']*apps\//,
    );
});
it("imports tooling with unsafe inherited credentials without constructing a client or doing I/O", async () => {
  const source = new URL("../src/index.ts", import.meta.url).href;
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import cp from 'node:child_process'; import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    cp.execFile = () => { throw Error('Unexpected Docker process'); };
    const read = fs.readFileSync;
    fs.readFileSync = (path, ...args) => { if (String(path).includes('.env.localstack')) throw Error('Token discovery'); return read(path, ...args); };
    syncBuiltinESMExports(); globalThis.fetch = () => { throw Error('Unexpected network'); };
    await import(${JSON.stringify(source)});
  `,
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      timeout: 15_000,
      env: {
        PATH: process.env.PATH,
        AWS_PROFILE: "must-not-load",
        AWS_ACCESS_KEY_ID: "must-not-load",
      },
    },
  );
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
});
it("rejects a changed but still valid ZIP/profile before Docker work", async () => {
  const f = await setup();
  await writeFile(f.statePath, JSON.stringify(manifest(f.profile)));
  await writeFile(f.path, Buffer.concat([await readFile(f.path), Buffer.from("changed")]));
  await expect(verifyArchives(f.profile)).rejects.toThrow("identity changed");
  const docker = vi.fn(async () => "");
  await expect(openLab({ ...f, operation: "inspect", docker })).rejects.toThrow("identity changed");
  expect(docker).not.toHaveBeenCalled();
});
it("rejects a changed profile, but permits exact owned down with missing archives", async () => {
  const f = await setup();
  await writeFile(f.statePath, JSON.stringify(manifest(f.profile)));
  const p = structuredClone(f.profile);
  p.functions[0]!.handler = "index.changed";
  const docker = vi.fn(async () => "");
  await expect(
    openLab({ ...f, profile: parseProfile(p), operation: "up", docker }),
  ).rejects.toThrow("profile changed");
  expect(docker).not.toHaveBeenCalled();
  await rm(f.path);
  const d = dockerDouble(f.profile);
  d.start();
  const s = await openLab({ ...f, operation: "down", docker: d.docker });
  cleanups.push(() => s.close());
  await s.down();
  await expect(access(f.statePath)).rejects.toThrow();
});
it("rejects a rebound port and a changed on-disk owner before stopping anything", async () => {
  const f = await setup();
  await writeFile(f.statePath, JSON.stringify(manifest(f.profile)));
  const d = dockerDouble(f.profile);
  const c = d.start();
  c.ports = { "4566/tcp": [{ HostIp: "0.0.0.0", HostPort: "4566" }] };
  const s = await openLab({ ...f, operation: "down", docker: d.docker });
  cleanups.push(() => s.close());
  await expect(s.down()).rejects.toThrow("not proven");
  c.ports = { "4566/tcp": [{ HostPort: "4566", HostIp: "127.0.0.1" }] };
  await s.inspect();
  await writeFile(
    f.statePath,
    JSON.stringify({ ...manifest(f.profile), ownerId: "bb551050-50ca-4c65-a8c1-f035cc275197" }),
  );
  await expect(s.down()).rejects.toThrow("Manifest changed");
  expect(d.calls.some((a) => ["stop", "rm"].includes(a[0]!))).toBe(false);
});
it("bounds runtime profiles before invoking Docker", async () => {
  const docker = vi.fn(async () => "");
  await expect(inspectRuntimes(docker, { project: ".*", functions: [] }, ownerId)).rejects.toThrow(
    "profile identity",
  );
  expect(docker).not.toHaveBeenCalled();
});
it("refuses an empty untagged legacy network instead of adopting it by Compose labels", async () => {
  const f = await setup();
  const {
    profile: _profile,
    profileHash: _hash,
    entitlement: _plan,
    ...rest
  } = manifest(f.profile);
  void _profile;
  void _hash;
  void _plan;
  await writeFile(f.statePath, JSON.stringify({ ...rest, schemaVersion: 1 }));
  const d = dockerDouble(f.profile);
  d.start();
  d.records.clear();
  delete d.network!.labels["jawstack.owner"];
  delete d.network!.labels["jawstack.profile"];
  const s = await openLab({ ...f, operation: "down", docker: d.docker, legacy: f.profile });
  cleanups.push(() => s.close());
  await expect(s.down()).rejects.toThrow("Legacy network ownership");
  expect(
    d.calls.some((a) => ["stop", "rm"].includes(a[0]!) || (a[0] === "network" && a[1] === "rm")),
  ).toBe(false);
  await access(f.statePath);
});
