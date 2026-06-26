import { defineJawStackApp } from "@jawstack/cli";

import { demoAppName, demoCostProfile, demoResources, demoStage } from "./src/example";

export default defineJawStackApp({
  appName: demoAppName,
  stage: demoStage,
  resources: demoResources,
  auth: {
    mode: "external",
    provider: "header",
  },
  costProfile: demoCostProfile,
});
