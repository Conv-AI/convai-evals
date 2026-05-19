import { defineConfig } from "vite";
import path from "node:path";

// Bundles the worker entry into a single static page consumed by Playwright pages.
// Output goes into server/src/static so the server can serve it under /worker.

export default defineConfig({
  base: "/worker/",
  build: {
    target: "es2022",
    outDir: path.resolve(__dirname, "../server/src/static"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: path.resolve(__dirname, "worker.html"),
    },
  },
});
