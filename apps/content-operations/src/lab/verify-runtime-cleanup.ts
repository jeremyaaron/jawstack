import { randomUUID } from "node:crypto";
import { LabError, type LabConfig } from "./config";
import { inspectRuntimes, type DockerCommand } from "./containers";

export async function verifyRuntimeCleanup(
  docker: DockerCommand,
  config: LabConfig,
  ownerId: string,
  shutdown: () => Promise<unknown>,
) {
  const runtimes = await inspectRuntimes(docker, config, ownerId);
  const runtime = runtimes[0];
  if (!runtime)
    throw new LabError("A real warm Lambda runtime is required for the cleanup fixture.");
  const image = await docker(["inspect", "--format", "{{.Image}}", runtime.id]);
  if (!/^sha256:[a-f0-9]{64}$/.test(image))
    throw new LabError("Cannot prove the cached Lambda image.");
  const create = (owner: string, command = "exit 0") =>
    docker([
      "create",
      "--name",
      `${config.project}-localstack-1-lambda-${config.worker.toLowerCase()}-${randomUUID().replaceAll("-", "")}`,
      "--label",
      `jawstack.owner=${owner}`,
      "--label",
      `jawstack.lab=${config.project}`,
      "--label",
      "jawstack.runtime=lambda",
      "--entrypoint",
      "/bin/sh",
      image,
      "-c",
      command,
    ]);
  const owned = await create(ownerId);
  const running = await create(ownerId, "sleep 600");
  const foreignOwner = randomUUID();
  const foreign = await create(foreignOwner);
  if (![owned, running, foreign].every((id) => /^[a-f0-9]{64}$/.test(id)))
    throw new LabError("Invalid cleanup fixture identity.");
  const removeForeignFixture = async () => {
    // This exact sentinel was created by this test with a separate owner; it is not adopted.
    if (
      (await docker([
        "inspect",
        "--format",
        '{{index .Config.Labels "jawstack.owner"}}',
        foreign,
      ])) !== foreignOwner
    )
      throw new LabError("Foreign test sentinel ownership changed.");
    await docker(["rm", foreign]);
  };
  try {
    await docker(["start", "--attach", owned]);
    if ((await docker(["inspect", "--format", "{{.State.Status}}", owned])) !== "exited")
      throw new LabError("Owned runtime cleanup fixture did not exit.");
    await docker(["start", running]);
    if ((await docker(["inspect", "--format", "{{.State.Status}}", running])) !== "running")
      throw new LabError("Owned runtime cleanup fixture did not start.");
    let refused = false;
    try {
      await shutdown();
    } catch (error) {
      refused = error instanceof LabError && error.message.includes("ownership/name");
    }
    if (!refused) throw new LabError("Foreign-lookalike shutdown was not refused.");
    for (const [id, owner] of [
      [owned, ownerId],
      [running, ownerId],
      [foreign, foreignOwner],
    ]) {
      if (
        (await docker([
          "inspect",
          "--format",
          '{{index .Config.Labels "jawstack.owner"}}',
          id!,
        ])) !== owner
      )
        throw new LabError("Cleanup fixture was changed during refusal.");
    }
    const emulator = await docker([
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${config.project}`,
    ]);
    if (!emulator) throw new LabError("Foreign-lookalike refusal stopped the emulator.");
    if ((await docker(["inspect", "--format", "{{.State.Status}}", running])) !== "running")
      throw new LabError("Foreign-lookalike refusal stopped an owned runtime.");
  } finally {
    await removeForeignFixture();
  }
  const result = await shutdown();
  for (const id of [owned, running])
    if (await docker(["ps", "-aq", "--filter", `id=${id}`]))
      throw new LabError("Owned runtime fixture survived shutdown.");
  return {
    result,
    foreignLookalikeRefusedBeforeStop: true,
    exitedOwnedFixtureRemoved: true,
    runningOwnedFixtureStoppedAndRemoved: true,
    actualCachedRuntimeImageUsed: true,
    matchingContainersAfterDown: 0,
  };
}
