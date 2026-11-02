import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import {
  archiveIdentity,
  localstackImage,
  parseProfile,
  profileHash,
  type LabProfile,
} from "../src/index";
import type { DockerCommand } from "../src/containers";

export const ownerId = "7dc55154-f37c-499a-90a6-841fbc0cbe1c";
export async function fixture(label = "first") {
  const root = await mkdtemp(join(tmpdir(), "jawstack-lab-test-"));
  const path = join(root, "handler.zip");
  await writeFile(
    path,
    zipSync({ "index.mjs": Buffer.from("export const handler=async()=>({ok:true});") }),
  );
  const project = `jawstack-${label}-lab`;
  const profile = parseProfile({
    schemaVersion: 1,
    instanceId: "test",
    project,
    functions: [
      { name: `${project}-worker`, handler: "index.handler", archive: await archiveIdentity(path) },
    ],
    resources: {
      tables: [`${project}-state`],
      buses: [],
      queues: [],
      roles: [],
      buckets: [],
      scheduleGroups: [],
    },
  });
  return {
    root,
    path,
    profile,
    statePath: join(root, "test.json"),
    expected: { instanceId: profile.instanceId, project },
    clean: () => rm(root, { recursive: true, force: true }),
  };
}
export function manifest(profile: LabProfile) {
  return {
    schemaVersion: 2 as const,
    instanceId: profile.instanceId,
    ownerId,
    image: localstackImage,
    status: "starting" as const,
    architecture: "arm64" as const,
    mappings: [],
    profile,
    profileHash: profileHash(profile),
    entitlement: { plan: "hobby" as const, attestedAt: "2026-11-01T00:00:00.000Z" },
  };
}
export function dockerDouble(p: LabProfile, owner = ownerId) {
  type Container = {
    id: string;
    name: string;
    image: string;
    status: string;
    labels: Record<string, string>;
    ports?: unknown;
  };
  const records = new Map<string, Container>();
  let network:
    | {
        id: string;
        name: string;
        labels: Record<string, string>;
        containers: Record<string, unknown>;
      }
    | undefined;
  const calls: string[][] = [];
  const id = () => randomUUID().replaceAll("-", "").repeat(2);
  const runtime = (status = "running", labels = {}) => {
    const value: Container = {
      id: id(),
      name: `/${p.project}-localstack-1-lambda-${p.functions[0]!.name.toLowerCase()}-${randomUUID().replaceAll("-", "")}`,
      image: "runtime-image",
      status,
      labels: {
        "jawstack.owner": owner,
        "jawstack.lab": p.project,
        "jawstack.runtime": "lambda",
        ...labels,
      },
    };
    records.set(value.id, value);
    return value;
  };
  const start = () => {
    const value: Container = {
      id: id(),
      name: `/${p.project}-localstack-1`,
      image: localstackImage,
      ports: { "4566/tcp": [{ HostIp: "127.0.0.1", HostPort: "4566" }] },
      status: "running",
      labels: {
        "jawstack.owner": owner,
        "jawstack.profile": profileHash(p),
        "com.docker.compose.project": p.project,
        "com.docker.compose.service": "localstack",
      },
    };
    records.set(value.id, value);
    network = {
      id: id(),
      name: `${p.project}-lab`,
      labels: {
        "com.docker.compose.project": p.project,
        "com.docker.compose.network": "lab",
        "jawstack.owner": owner,
        "jawstack.profile": profileHash(p),
      },
      containers: {},
    };
    return value;
  };
  const docker: DockerCommand = async (args) => {
    calls.push(args);
    if (args[0] === "ps") {
      const filter = args[args.indexOf("--filter") + 1]!;
      return [...records.values()]
        .filter((r) => {
          if (filter.startsWith("id=")) return r.id.startsWith(filter.slice(3));
          if (filter.startsWith("name=")) return new RegExp(filter.slice(5)).test(r.name);
          const [key, value] = filter.slice(6).split("=");
          return r.labels[key!] === value;
        })
        .map((r) => r.id)
        .join("\n");
    }
    if (args[0] === "inspect") return JSON.stringify(records.get(args.at(-1)!));
    if (args[0] === "compose") {
      const compose = JSON.parse(await readFile(args[args.indexOf("--file") + 1]!, "utf8"));
      if (compose.services.localstack.image !== localstackImage)
        throw Error("Unexpected compose image");
      start();
      return "";
    }
    if (args[0] === "stop") {
      records.get(args.at(-1)!)!.status = "exited";
      return "";
    }
    if (args[0] === "rm") {
      records.delete(args[1]!);
      return "";
    }
    if (args[0] === "network") {
      if (args[1] === "ls") return network?.id ?? "";
      if (args[1] === "inspect")
        return JSON.stringify({
          ...network,
          containers: {
            ...network?.containers,
            ...Object.fromEntries([...records.values()].map((r) => [r.id, {}])),
          },
        });
      if (args[1] === "rm") {
        network = undefined;
        return "";
      }
    }
    throw Error("Unexpected Docker operation");
  };
  return {
    docker,
    calls,
    records,
    runtime,
    start,
    get network() {
      return network;
    },
  };
}
