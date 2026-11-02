import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  archiveIdentity,
  assertMapping,
  assertOwned,
  createLabTransport,
  decodeManifest,
  deleteMappings,
  missing,
  openLab,
  parseProfile,
  profileHash,
  verifyArchives,
  waitFor,
} from "../src/index";
import { dockerDouble, fixture, manifest, ownerId } from "./support";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
const setup = async (name?: string) => {
  const f = await fixture(name);
  cleanups.push(f.clean);
  return f;
};
describe("finite private lab profile", () => {
  it("owns/freeze-captures profiles and hashes object keys canonically", async () => {
    const f = await setup();
    const source = structuredClone(f.profile);
    const captured = parseProfile(source);
    source.functions[0]!.handler = "index.changed";
    expect(captured.functions[0]!.handler).toBe("index.handler");
    expect(Object.isFrozen(captured.functions[0]!.archive)).toBe(true);
    expect(profileHash({ ...f.profile, resources: { ...f.profile.resources } })).toBe(
      profileHash(f.profile),
    );
    expect(profileHash(source)).not.toBe(profileHash(captured));
  });
  it.each(["unknown", "foreign", "duplicate", "oversize", "accessor", "path", "digest"])(
    "refuses %s profiles",
    async (variant) => {
      const f = await setup();
      const p = structuredClone(f.profile);
      if (variant === "unknown") Object.assign(p, { shell: "rm -rf /" });
      if (variant === "foreign") p.functions[0]!.name = "foreign-function";
      if (variant === "duplicate") p.functions.push(p.functions[0]!);
      if (variant === "oversize") p.functions = Array(101).fill(p.functions[0]);
      if (variant === "accessor")
        Object.defineProperty(p, "project", {
          enumerable: true,
          get: () => {
            throw Error("getter executed");
          },
        });
      if (variant === "path") p.functions[0]!.archive.path = "";
      if (variant === "digest") p.functions[0]!.archive.sha256 = "bad";
      expect(() => parseProfile(p)).toThrow("Invalid bounded");
    },
  );
  it("detects changed/missing/non-ZIP assets without adopting them", async () => {
    const f = await setup();
    await verifyArchives(f.profile);
    await writeFile(f.path, "not zip");
    await expect(archiveIdentity(f.path)).rejects.toThrow("ZIP");
    await expect(verifyArchives(f.profile)).rejects.toThrow("Cannot verify");
    await expect(archiveIdentity(join(f.root, "missing.zip"))).rejects.toThrow();
  });
  it("preflights exact owner/mapping identity and bounds deletion before mutations", async () => {
    expect(() => assertOwned({ "jawstack:owner": "other" }, ownerId)).toThrow();
    expect(() => assertMapping({ UUID: "id", EventSourceArn: "foreign" }, "expected")).toThrow();
    expect(assertMapping({ UUID: "id", EventSourceArn: "expected" }, "expected")).toBe("id");
    const remove = vi.fn(async () => {});
    await expect(deleteMappings(["id", "id"], remove, async () => false)).rejects.toThrow();
    expect(remove).not.toHaveBeenCalled();
    await deleteMappings(["id"], remove, async () => false);
    expect(remove).toHaveBeenCalledOnce();
    await expect(
      missing(async () => {
        throw Object.assign(Error(), { name: "NotFound" });
      }),
    ).resolves.toBeUndefined();
    await expect(
      missing(async () => {
        throw Error("transport failed");
      }),
    ).rejects.toThrow("transport failed");
    await expect(
      waitFor(
        "bounded",
        async () => undefined,
        0,
        async () => {},
      ),
    ).rejects.toThrow("bounded");
  });
});
describe("manifest and shared lifecycle", () => {
  it.each(["first", "second"])("starts and tears down the %s independent profile", async (name) => {
    const f = await setup(name);
    const disk = manifest(f.profile);
    await writeFile(f.statePath, JSON.stringify(disk));
    const d = dockerDouble(f.profile);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );
    vi.stubEnv("LOCALSTACK_AUTH_TOKEN", "unit-only-token");
    vi.stubEnv("JAWSTACK_LOCALSTACK_PLAN", "hobby");
    const s = await openLab({ ...f, operation: "up", docker: d.docker });
    cleanups.push(() => s.close());
    expect(await s.up()).toMatchObject({ status: "ready", project: f.profile.project });
    const persisted = JSON.parse(await readFile(f.statePath, "utf8"));
    expect(persisted.entitlement.plan).toBe("hobby");
    expect(JSON.stringify(persisted)).not.toContain("unit-only-token");
    d.runtime();
    d.runtime("exited");
    vi.stubEnv("LOCALSTACK_AUTH_TOKEN", "");
    vi.stubEnv("JAWSTACK_LOCALSTACK_PLAN", "");
    expect(await s.down()).toMatchObject({
      stopped: 1,
      removed: 2,
      emulatorContainers: 0,
      networks: 0,
    });
    await expect(access(f.statePath)).rejects.toThrow();
  });
  it.each(["runtime", "emulator", "network", "member", "image"])(
    "refuses a foreign %s before any stop/remove",
    async (variant) => {
      const f = await setup();
      await writeFile(f.statePath, JSON.stringify(manifest(f.profile)));
      const d = dockerDouble(f.profile);
      const emulator = d.start();
      if (variant === "runtime") d.runtime("running", { "jawstack.owner": "foreign" });
      if (variant === "emulator") emulator.labels["jawstack.owner"] = "foreign";
      if (variant === "network") d.network!.labels["jawstack.owner"] = "foreign";
      if (variant === "member") d.network!.containers["f".repeat(64)] = {};
      if (variant === "image") emulator.image = "unpinned-image";
      const s = await openLab({ ...f, operation: "down", docker: d.docker });
      cleanups.push(() => s.close());
      await expect(s.down()).rejects.toThrow();
      expect(
        d.calls.some(
          (a) => ["stop", "rm", "compose"].includes(a[0]!) || (a[0] === "network" && a[1] === "rm"),
        ),
      ).toBe(false);
      expect(emulator.status).toBe("running");
      await access(f.statePath);
    },
  );
  it("cleans up owned orphan runtimes with no emulator, but refuses startup over them", async () => {
    const f = await setup();
    await writeFile(f.statePath, JSON.stringify(manifest(f.profile)));
    const d = dockerDouble(f.profile);
    d.runtime();
    d.runtime("exited");
    const s = await openLab({ ...f, operation: "up", docker: d.docker });
    cleanups.push(() => s.close());
    await expect(s.up()).rejects.toThrow("orphans");
    expect(d.calls.some((a) => a[0] === "stop")).toBe(false);
    expect(await s.down()).toMatchObject({ removed: 2 });
  });
  it.each(["hash", "owner", "instance", "unknown", "queue", "huge"])(
    "refuses malformed %s manifests before Docker calls",
    async (variant) => {
      const f = await setup();
      const m = manifest(f.profile);
      if (variant === "hash") m.profileHash = "b".repeat(64);
      if (variant === "owner") m.ownerId = "foreign";
      if (variant === "instance") m.instanceId = "other";
      if (variant === "unknown") Object.assign(m, { token: "private-value" });
      if (variant === "queue")
        Object.assign(m, { queueUrl: "https://sqs.us-east-1.amazonaws.com/000000000000/foreign" });
      await writeFile(
        f.statePath,
        variant === "huge" ? " ".repeat(256 * 1024 + 1) : JSON.stringify(m),
      );
      const docker = vi.fn(async () => "");
      await expect(openLab({ ...f, operation: "down", docker })).rejects.toThrow();
      expect(docker).not.toHaveBeenCalled();
      await access(f.statePath);
    },
  );
  it("accepts legacy only with an explicit teardown profile, never as an upgrade", async () => {
    const f = await setup();
    const current = manifest(f.profile);
    const { profile: _profile, profileHash: _hash, entitlement: _plan, ...rest } = current;
    void _profile;
    void _hash;
    void _plan;
    const old = { ...rest, schemaVersion: 1 };
    expect(() => decodeManifest(old, f.expected)).toThrow("legacy");
    await writeFile(f.statePath, JSON.stringify(old));
    const d = dockerDouble(f.profile);
    const c = d.start();
    delete c.labels["jawstack.profile"];
    delete d.network!.labels["jawstack.owner"];
    delete d.network!.labels["jawstack.profile"];
    await expect(
      openLab({ ...f, operation: "up", docker: d.docker, legacy: f.profile }),
    ).rejects.toThrow("down only");
    const s = await openLab({ ...f, operation: "down", docker: d.docker, legacy: f.profile });
    cleanups.push(() => s.close());
    await expect(s.save()).rejects.toThrow("cannot rewrite");
    expect(await s.down()).toMatchObject({ emulatorContainers: 0, networks: 0 });
  });
  it("locks sessions and preserves immutable owner/profile when saving", async () => {
    const f = await setup();
    await writeFile(f.statePath, JSON.stringify(manifest(f.profile)));
    const d = dockerDouble(f.profile);
    const s = await openLab({ ...f, operation: "inspect", docker: d.docker });
    cleanups.push(() => s.close());
    await expect(openLab({ ...f, operation: "down", docker: d.docker })).rejects.toThrow("locked");
    s.manifest.ownerId = "bb551050-50ca-4c65-a8c1-f035cc275197";
    await expect(s.save()).rejects.toThrow("changed");
  });
  it("requires explicit token/Hobby startup, but down never discovers or reads a token file", async () => {
    const f = await setup();
    await writeFile(f.statePath, JSON.stringify(manifest(f.profile)));
    const d = dockerDouble(f.profile);
    const s = await openLab({ ...f, operation: "up", docker: d.docker });
    cleanups.push(() => s.close());
    vi.stubEnv("LOCALSTACK_AUTH_TOKEN", "");
    await expect(s.up()).rejects.toThrow("LOCALSTACK_AUTH_TOKEN");
    vi.stubEnv("LOCALSTACK_AUTH_TOKEN", "unit-only-token");
    vi.stubEnv("JAWSTACK_LOCALSTACK_PLAN", "trial");
    await expect(s.up()).rejects.toThrow("Hobby");
    expect(d.calls.some((a) => a[0] === "compose")).toBe(false);
    await s.save();
    expect(await s.down()).toMatchObject({ emulatorContainers: 0 });
  });
  it("retains the manifest after a Docker cleanup failure", async () => {
    const f = await setup();
    await writeFile(f.statePath, JSON.stringify(manifest(f.profile)));
    const d = dockerDouble(f.profile);
    d.start();
    const s = await openLab({
      ...f,
      operation: "down",
      docker: async (args) => {
        if (args[0] === "rm") throw Error("daemon failed");
        return d.docker(args);
      },
    });
    cleanups.push(() => s.close());
    await expect(s.down()).rejects.toThrow("daemon failed");
    await access(f.statePath);
  });
});
describe("public local transport reuse", () => {
  it("uses dummy identities and blocks nonlocal requests at the final handler", async () => {
    const transport = createLabTransport();
    expect(await transport.credentials()).toEqual({ accessKeyId: "test", secretAccessKey: "test" });
    const handle = vi.spyOn(NodeHttpHandler.prototype, "handle");
    expect(() =>
      transport.requestHandler.handle({
        protocol: "https:",
        hostname: "dynamodb.us-east-1.amazonaws.com",
        port: 443,
        headers: {},
      } as Parameters<NodeHttpHandler["handle"]>[0]),
    ).toThrow();
    expect(handle).not.toHaveBeenCalled();
    transport.requestHandler.destroy();
  });
  it("rejects inherited AWS settings before any Docker/network work", async () => {
    const f = await setup();
    vi.stubEnv("AWS_PROFILE", "must-not-load");
    const docker = vi.fn(async () => "");
    await expect(openLab({ ...f, operation: "up", docker })).rejects.toThrow("AWS_PROFILE");
    expect(docker).not.toHaveBeenCalled();
  });
});
