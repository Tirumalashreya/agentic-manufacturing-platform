// Phase 12 — frontend/ had zero test infrastructure before this (confirmed:
// no jest/vitest/testing-library, no test files anywhere). Vitest matches
// what every other TS service in this monorepo already uses
// (scheduling-service, order-service, erp-integration) — not a new
// framework choice, the same one extended to this app. jsdom is needed
// because these are React components, not plain Node modules.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
  },
});
