import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  build: {
    outDir: path.resolve(process.cwd(), "dist/renderer"),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@renderer": path.resolve(process.cwd(), "src/renderer/src"),
      "@": path.resolve(process.cwd(), "src/renderer/src"),
      "@shared": path.resolve(process.cwd(), "src/shared"),
    },
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": {
        target: "ws://127.0.0.1:8787",
        ws: true,
      },
    },
  },
});
