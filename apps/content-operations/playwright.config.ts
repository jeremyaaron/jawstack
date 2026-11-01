import { defineConfig } from "@playwright/test";

const apiPort = Number(process.env.CONTENT_OPS_E2E_API_PORT ?? 4437);
const webPort = Number(process.env.CONTENT_OPS_E2E_WEB_PORT ?? 4436);
if (
  ![apiPort, webPort].every((port) => Number.isInteger(port) && port > 0 && port < 65536) ||
  apiPort === webPort
)
  throw new Error("Invalid isolated browser-test ports.");
const env = {
  CONTENT_OPS_API_PORT: String(apiPort),
  CONTENT_OPS_WEB_PORT: String(webPort),
  CONTENT_OPS_RUNTIME: "memory",
};
export default defineConfig({
  testDir: "test/browser",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  outputDir: "test-results",
  reporter: "list",
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
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
      command: "pnpm exec tsx scripts/browser-api.ts",
      url: `http://127.0.0.1:${apiPort}/api/health`,
      env,
      reuseExistingServer: false,
      timeout: 30_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
    {
      command: "pnpm run dev:web",
      url: `http://127.0.0.1:${webPort}/src/web/main.ts`,
      env,
      reuseExistingServer: false,
      timeout: 60_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    },
  ],
});
