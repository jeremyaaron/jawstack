import { createMemoryApiRuntime } from "../src/application/api-runtime";
import { createSeeder } from "../src/application/seed";
import { startContentApi } from "../src/http/server";
import { apiSettings } from "./api";

async function main() {
  const settings = apiSettings(["memory"], process.env);
  const runtime = createMemoryApiRuntime();
  await createSeeder(runtime)();
  const api = await startContentApi({ runtime, port: settings.port, webPort: settings.webPort });
  console.log(`Isolated browser-test API: ${api.baseUrl}`);
  const stop = () => {
    void api.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
void main().catch(() => {
  console.error("Isolated browser-test API failed to start.");
  process.exitCode = 1;
});
