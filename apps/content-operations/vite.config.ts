import angular from "@analogjs/vite-plugin-angular";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

export const forbidden = (id: string) =>
  id.startsWith("node:") ||
  builtinModules.includes(id) ||
  /(?:^|\/)@(?:aws-sdk|smithy)(?:\/|\+)/.test(id) ||
  /^@jawstack\/(?:core|aws-runtime|aws-cdk)(?:\/|$)/.test(id) ||
  /(?:^|\/)(?:aws-cdk-lib|constructs)(?:[/@]|$)/.test(id) ||
  /(?:^|\/)(?:browser-shims|src\/(?:domain|application|aws|http|lab))(?:\/|$)/.test(id) ||
  /packages\/(?:core|aws-runtime|aws-cdk)\//.test(id);
export function browserBoundary(): Plugin {
  return {
    name: "content-operations-browser-boundary",
    enforce: "pre",
    configResolved(config) {
      if (config.server.host !== "127.0.0.1" || config.preview.host !== "127.0.0.1")
        throw new Error("The workbench binds only to 127.0.0.1.");
    },
    resolveId(id, importer) {
      if (importer && forbidden(id)) this.error(`Forbidden browser import: ${id}`);
      return null;
    },
    load(id) {
      if (forbidden(id)) this.error(`Forbidden browser module: ${id}`);
      return null;
    },
    generateBundle() {
      const ids = [...this.getModuleIds()];
      const blocked = ids.filter(forbidden);
      if (blocked.length) this.error(`Forbidden browser graph: ${blocked.join(", ")}`);
      for (const required of [
        "src/web/content-list.ts",
        "src/web/content-detail.ts",
        "src/web/review-list.ts",
        "src/web/review-detail.ts",
        "src/web/activity.ts",
        "src/shared/presentation.ts",
        "packages/angular/src/index.ts",
      ])
        if (!ids.some((id) => id.endsWith(required)))
          this.error(`Missing browser module: ${required}`);
      this.emitFile({
        type: "asset",
        fileName: "browser-boundary.json",
        source: JSON.stringify({ status: "passed", modules: ids.length, serverImports: 0 }),
      });
    },
  };
}
const port = (value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
    throw new Error("Invalid loopback port.");
  return parsed;
};
const apiPort = port(process.env.CONTENT_OPS_API_PORT, 4327);
const webPort = port(process.env.CONTENT_OPS_WEB_PORT, 4326);
if (apiPort === webPort) throw new Error("API and web ports must differ.");
if (
  (process.env.CONTENT_OPS_STAGE && !["local", "dev"].includes(process.env.CONTENT_OPS_STAGE)) ||
  (process.env.CONTENT_OPS_RUNTIME &&
    !["memory", "localstack"].includes(process.env.CONTENT_OPS_RUNTIME))
)
  throw new Error("Only explicit local development modes are supported.");
export default defineConfig(({ command }) => ({
  plugins: [
    browserBoundary(),
    angular({ tsconfig: fileURLToPath(new URL("./tsconfig.app.json", import.meta.url)) }),
  ],
  resolve: {
    alias: {
      "@jawstack/angular": fileURLToPath(
        new URL("../../packages/angular/src/index.ts", import.meta.url),
      ),
    },
  },
  optimizeDeps: { include: ["@js-temporal/polyfill"] },
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
  },
  preview: { host: "127.0.0.1", port: webPort, strictPort: true },
  build: { outDir: "dist/web", emptyOutDir: true, chunkSizeWarningLimit: 700 },
  cacheDir: `../../node_modules/.vite/content-operations/${command}-${webPort}`,
}));
