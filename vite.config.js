import { defineConfig } from "vite";

// Frontend lives in ./src; built output goes to ./dist (consumed by Tauri).
export default defineConfig({
  root: "src",
  publicDir: "assets",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "safari15",
    minify: true,
  },
});
