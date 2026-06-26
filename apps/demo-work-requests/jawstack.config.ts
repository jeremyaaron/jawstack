import { defineJawStackApp } from "@jawstack/cli";

import { demoAppName, demoCostProfile, demoResources } from "./src/example";

export default defineJawStackApp({
  appName: demoAppName,
  stage: "dev",
  resources: demoResources,
  auth: {
    mode: "external",
    provider: "header",
  },
  costProfile: demoCostProfile,
});
