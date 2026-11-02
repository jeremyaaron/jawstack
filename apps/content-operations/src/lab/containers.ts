import {
  ownedRuntime as sharedOwnedRuntime,
  inspectRuntimes as sharedInspectRuntimes,
  cleanupRuntimes as sharedCleanupRuntimes,
  type DockerCommand,
} from "@jawstack/local-lab/containers";
import { labFunctions, type LabConfig } from "./config";
import { applicationProfile } from "../aws/profile";

export type { DockerCommand };
export const runtimeProfile = (config: LabConfig) => ({
  project: config.project,
  functions: [...labFunctions(config), ...applicationProfile(config).functions],
});
export const ownedRuntime = (input: unknown, config: LabConfig, ownerId: string) =>
  sharedOwnedRuntime(input, runtimeProfile(config), ownerId);
export const inspectRuntimes = (
  docker: DockerCommand,
  config: LabConfig,
  ownerId: string,
  removalTimeoutMs?: number,
) => sharedInspectRuntimes(docker, runtimeProfile(config), ownerId, removalTimeoutMs);
export const cleanupRuntimes = (docker: DockerCommand, config: LabConfig, ownerId: string) =>
  sharedCleanupRuntimes(docker, runtimeProfile(config), ownerId);
