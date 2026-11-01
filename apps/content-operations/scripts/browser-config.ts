import { defineConfig } from "@playwright/test";

export function browserSettings(runtime: "memory" | "localstack", env: NodeJS.ProcessEnv = {}) {
  const apiPort = Number(env.CONTENT_OPS_E2E_API_PORT ?? (runtime === "memory" ? 4437 : 4537));
  const webPort = Number(env.CONTENT_OPS_E2E_WEB_PORT ?? (runtime === "memory" ? 4436 : 4536));
  if (
    ![apiPort, webPort].every((port) => Number.isInteger(port) && port > 0 && port < 65536) ||
    apiPort === webPort
  )
    throw new Error("Invalid isolated browser-test ports.");
  const labId = env.CONTENT_OPS_LAB_ID ?? "dev";
  if (!/^[a-z][a-z0-9-]{0,15}$/.test(labId)) throw new Error("Invalid browser lab identifier.");
  return { apiPort, webPort, labId, runtime };
}

export function browserConfig(
  runtime: "memory" | "localstack",
  source: NodeJS.ProcessEnv = process.env,
) {
  const settings = browserSettings(runtime, source);
  const env = {
    CONTENT_OPS_API_PORT: String(settings.apiPort),
    CONTENT_OPS_WEB_PORT: String(settings.webPort),
    CONTENT_OPS_RUNTIME: runtime,
    CONTENT_OPS_LAB_ID: settings.labId,
    LOCALSTACK_AUTH_TOKEN: "",
  };
  return defineConfig({
    testDir: "test/browser",
    ...(runtime === "localstack" ? { testMatch: "workflow.spec.ts" } : {}),
    fullyParallel: false,
    workers: 1,
    forbidOnly: !!source.CI,
    retries: 0,
    globalTimeout: 600_000,
    outputDir: `test-results/${runtime}`,
    reporter: [["list"], ["json", { outputFile: `test-results/${runtime}-results.json` }]],
    timeout: 30_000,
    metadata: { runtime, labId: settings.labId },
    use: {
      baseURL: `http://127.0.0.1:${settings.webPort}`,
      trace: "retain-on-failure",
      screenshot: "only-on-failure",
      actionTimeout: 15_000,
      navigationTimeout: 30_000,
    },
    projects: [
      { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
      {
        name: "mobile",
        use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      },
    ],
    webServer: [
      {
        command:
          runtime === "memory" ? "pnpm exec tsx scripts/browser-api.ts" : "pnpm run dev:api:local",
        url: `http://127.0.0.1:${settings.apiPort}/api/health`,
        env,
        reuseExistingServer: false,
        timeout: 30_000,
        gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      },
      {
        command: "pnpm run dev:web",
        url: `http://127.0.0.1:${settings.webPort}/src/web/main.ts`,
        env,
        reuseExistingServer: false,
        timeout: 60_000,
        gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      },
    ],
  });
}
