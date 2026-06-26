#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const requiredConfirmation = "deploy-dev";
const confirmation = process.env.JAWSTACK_AWS_DEV_CONFIRM;
const keepStack = process.env.JAWSTACK_AWS_DEV_KEEP_STACK === "1";

if (confirmation !== requiredConfirmation) {
  process.stderr.write(
    [
      "Refusing to run the AWS dev smoke cycle without explicit confirmation.",
      "",
      `Set JAWSTACK_AWS_DEV_CONFIRM=${requiredConfirmation} and configure AWS_PROFILE/AWS_REGION first.`,
      "This script deploys real AWS resources, runs smoke, then destroys the dev stack.",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

let deployed = false;
let smokeStatus = 0;

try {
  run("pnpm", ["--filter", "demo-work-requests", "run", "doctor:deploy"]);
  run("pnpm", ["--filter", "demo-work-requests", "run", "deploy:dev"]);
  deployed = true;
  run("pnpm", ["--filter", "demo-work-requests", "run", "smoke:dev"]);
} catch (error) {
  smokeStatus = exitStatus(error);
  process.exitCode = smokeStatus;
} finally {
  if (deployed && !keepStack) {
    try {
      run("pnpm", ["--filter", "demo-work-requests", "run", "destroy:dev"]);
    } catch (error) {
      process.exitCode = exitStatus(error);
    }
  }
}

function run(command, args) {
  process.stdout.write(`\n$ ${command} ${args.join(" ")}\n`);
  execFileSync(command, args, {
    env: process.env,
    stdio: "inherit",
  });
}

function exitStatus(error) {
  return typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : 1;
}
