import { App, Stack } from "aws-cdk-lib";
import { JawStackResourceWorkflowApp } from "@jawstack/aws-cdk";
import type { JawStackConfig } from "@jawstack/cli";
import type { ManifestAuth } from "@jawstack/core";

import config from "../jawstack.config";

const appConfig: JawStackConfig = config;
const app = new App();
const stage = app.node.tryGetContext("jawstackStage") ?? appConfig.stage ?? "dev";
const stackName = `${appConfig.appName}-${stage}`;
const region = appConfig.aws?.region ?? process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION;
const stack = new Stack(app, stackName, region === undefined ? {} : { env: { region } });

new JawStackResourceWorkflowApp(stack, "Workflow", {
  appName: appConfig.appName,
  stage,
  resources: appConfig.resources,
  auth: requireManifestAuth(appConfig.auth),
  costProfile: appConfig.costProfile,
  entrypoints: {
    apiHandler: "dist/aws/api",
    outboxHandler: "dist/aws/outbox",
  },
});

function requireManifestAuth(auth: JawStackConfig["auth"]): ManifestAuth {
  if (auth.mode === undefined || auth.provider === undefined) {
    throw new Error("JawStack CDK app requires config.auth.mode and config.auth.provider.");
  }

  return {
    mode: auth.mode,
    provider: auth.provider,
  };
}
