import angular from "@analogjs/vite-plugin-angular";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    angular({
      tsconfig: fileURLToPath(new URL("./tsconfig.app.json", import.meta.url)),
    }),
  ],
  resolve: {
    alias: {
      "node:http": fileURLToPath(new URL("./src/browser-shims/node-http.ts", import.meta.url)),
    },
  },
  server: {
    port: 4316,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4317",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  cacheDir: "node_modules/.vite",
});
