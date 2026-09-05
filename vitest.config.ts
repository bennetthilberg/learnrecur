import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/setup/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],
    setupFiles: ["./tests/setup/env.ts"],
    testTimeout: 30_000,
    // Database suites share one small Neon compute. Unbounded file workers
    // exhaust its transaction budget and make ownership/race checks time out.
    maxWorkers: process.env.RUN_DATABASE_TESTS === "1" ? 2 : undefined,
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/generated/**"],
      reporter: ["text", "html"],
      thresholds: {
        // This is the first enforced whole-repository baseline. Raise these
        // floors as coverage grows; never lower them to make a PR pass.
        branches: 42,
        functions: 55,
        lines: 47,
        statements: 47,
        "src/lib/answer-checking/**": {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
        "src/lib/scheduling/**": {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
      },
    },
  },
});
