import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

import { parseE2EUserCount } from "./tests/e2e/support/config";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

const baseURL = process.env.E2E_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const e2eWorkers = parseE2EUserCount(process.env.E2E_CLERK_USER_COUNT);
const webServer = localWebServer(baseURL);

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  workers: e2eWorkers,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  webServer,
  projects: [
    {
      name: "clerk-setup",
      testMatch: /clerk\.setup\.ts/,
      teardown: "clerk-cleanup",
    },
    {
      name: "clerk-cleanup",
      testMatch: /clerk\.teardown\.ts/,
    },
    {
      name: "anonymous-chromium",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /auth-spine\.spec\.ts/,
    },
    {
      name: "authenticated-chromium",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /authenticated\/.*\.spec\.ts/,
      dependencies: ["clerk-setup"],
    },
  ],
});

function localWebServer(target: string) {
  const url = new URL(target);
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    return undefined;
  }
  if (url.protocol !== "http:") {
    throw new Error("Local Playwright targets must use http://.");
  }

  const port = url.port || "3000";
  return {
    command: `npm run dev:app -- --hostname ${url.hostname} --port ${port}`,
    url: target,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  };
}
