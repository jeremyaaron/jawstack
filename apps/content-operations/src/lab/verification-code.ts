import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { GetFunctionCommand, UpdateFunctionCodeCommand } from "@aws-sdk/client-lambda";
import { applicationProfile } from "../aws/profile";
import { assertOwned, LabError, type LabConfig } from "./config";
import type { LabClients } from "./clients";
import { waitFor } from "./lifecycle";

export async function instrumentWorkers(clients: LabClients, config: LabConfig, ownerId: string) {
  const profile = applicationProfile(config);
  const verification = await readFile(new URL("../../dist/verification.zip", import.meta.url));
  const targets = profile.functions.filter((fn) => fn.queue);
  const snapshots: { name: string; bytes: Uint8Array; hash: string }[] = [];
  for (const fn of targets) {
    const current = await clients.lambda.send(new GetFunctionCommand({ FunctionName: fn.name }));
    assertOwned(current.Tags, ownerId);
    if (
      current.Configuration?.Environment?.Variables?.CONTENT_OPS_OWNER_ID !== ownerId ||
      current.Configuration.Handler !== fn.handler
    )
      throw new LabError("Cannot confirm verification target configuration.");
    const bytes = await readFile(new URL(`../../dist/${fn.bundle}.zip`, import.meta.url));
    const hash = createHash("sha256").update(bytes).digest("base64");
    if (current.Configuration.CodeSha256 !== hash)
      throw new LabError(
        "Owned worker code differs from the built standard archive; reprovision before verification.",
      );
    snapshots.push({ name: fn.name, bytes, hash });
  }
  const update = async (name: string, bytes: Uint8Array, hash: string) => {
    assertOwned(
      (await clients.lambda.send(new GetFunctionCommand({ FunctionName: name }))).Tags,
      ownerId,
    );
    await clients.lambda.send(
      new UpdateFunctionCodeCommand({ FunctionName: name, ZipFile: bytes }),
    );
    await waitFor("verification worker code readiness", async () => {
      const fn = (await clients.lambda.send(new GetFunctionCommand({ FunctionName: name })))
        .Configuration;
      if (fn?.LastUpdateStatus === "Failed" || fn?.State === "Failed")
        throw new LabError("Verification code update failed.");
      return fn?.State === "Active" &&
        fn.LastUpdateStatus === "Successful" &&
        fn.CodeSha256 === hash
        ? true
        : undefined;
    });
  };
  const changed: typeof snapshots = [];
  const restore = async () => {
    const failures: unknown[] = [];
    for (const fn of changed) {
      try {
        await update(fn.name, fn.bytes, fn.hash);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new LabError(`Failed to restore ${failures.length} owned worker archives.`);
  };
  try {
    for (const fn of snapshots) {
      changed.push(fn);
      await update(
        fn.name,
        verification,
        createHash("sha256").update(verification).digest("base64"),
      );
    }
  } catch (error) {
    await restore();
    throw error;
  }
  return restore;
}
