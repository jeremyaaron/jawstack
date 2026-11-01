import { z } from "zod";
import { LabError, labFunctions, type LabConfig } from "./config";
import { applicationProfile } from "../aws/profile";
import { waitFor } from "./lifecycle";

export type DockerCommand = (args: string[], timeout?: number) => Promise<string>;
const containerSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string(),
  status: z.enum(["running", "exited", "created", "removing"]),
  labels: z.record(z.string(), z.string()).nullable(),
});
export function ownedRuntime(input: unknown, config: LabConfig, ownerId: string) {
  const parsed = containerSchema.safeParse(input);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "record"))),
    ];
    throw new LabError(`Invalid runtime inventory fields (${fields.join(", ")}); cleanup refused.`);
  }
  const container = parsed.data;
  const names = [...labFunctions(config), ...applicationProfile(config).functions].map((fn) =>
    fn.name.toLowerCase(),
  );
  if (
    container.labels?.["jawstack.owner"] !== ownerId ||
    container.labels["jawstack.lab"] !== config.project ||
    container.labels["jawstack.runtime"] !== "lambda" ||
    !names.some((name) =>
      new RegExp(`^/${config.project}-localstack-1-lambda-${name}-[a-f0-9]{32}$`).test(
        container.name,
      ),
    )
  )
    throw new LabError(
      "Runtime container ownership/name is not proven; refusing cleanup. Manifest retained.",
    );
  return container;
}
export async function inspectRuntimes(
  docker: DockerCommand,
  config: LabConfig,
  ownerId: string,
  removalTimeoutMs = 30_000,
) {
  const candidates = new Set<string>();
  for (const filter of [
    `name=^/${config.project}-localstack-1-lambda-`,
    `label=jawstack.lab=${config.project}`,
  ]) {
    for (const id of (await docker(["ps", "-aq", "--filter", filter]))
      .split(/\s+/)
      .filter(Boolean)) {
      if (!/^[a-f0-9]{12,64}$/.test(id)) throw new LabError("Invalid runtime container inventory.");
      candidates.add(id);
    }
  }
  const records = [];
  for (const id of candidates) {
    let inspected: string;
    try {
      inspected = await docker([
        "inspect",
        "--format",
        '{"id":{{json .Id}},"name":{{json .Name}},"status":{{json .State.Status}},"labels":{{json .Config.Labels}}}',
        id,
      ]);
    } catch (error) {
      if (await docker(["ps", "-aq", "--filter", `id=${id}`])) throw error;
      continue;
    }
    const value = JSON.parse(inspected);
    const record = ownedRuntime(value, config, ownerId);
    if (!record.id.startsWith(id)) throw new LabError("Runtime container identity changed.");
    if (record.status === "removing") {
      await waitFor(
        "already-removing owned runtime disappearance",
        async () =>
          (await docker(["ps", "-aq", "--filter", `id=${record.id}`])) ? undefined : true,
        removalTimeoutMs,
      );
      continue;
    }
    records.push(record);
  }
  return records;
}
export async function cleanupRuntimes(docker: DockerCommand, config: LabConfig, ownerId: string) {
  const initial = await inspectRuntimes(docker, config, ownerId);
  const perform = async (args: string[], id: string) => {
    try {
      await docker(args, 30_000);
    } catch (error) {
      if (await docker(["ps", "-aq", "--filter", `id=${id}`])) throw error;
    }
  };
  for (const record of initial)
    if (record.status === "running") await perform(["stop", "--time", "10", record.id], record.id);
  const stopped = await inspectRuntimes(docker, config, ownerId);
  if (stopped.some((record) => !["exited", "created"].includes(record.status)))
    throw new LabError("Owned runtime is not stopped; refusing removal.");
  for (const record of stopped) await perform(["rm", record.id], record.id);
  if ((await inspectRuntimes(docker, config, ownerId)).length)
    throw new LabError("Owned runtimes remain after cleanup.");
  return {
    stopped: initial.filter((record) => record.status === "running").length,
    removed: stopped.length,
  };
}
