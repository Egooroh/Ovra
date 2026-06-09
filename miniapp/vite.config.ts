import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Mini App is served by the Go backend under /app/, so every asset URL must
// be prefixed with /app/. In dev, /app/api is proxied to the Go server so the
// SPA can call the same authenticated endpoints it will hit in production.
export default defineConfig({
  base: "/app/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/app/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
