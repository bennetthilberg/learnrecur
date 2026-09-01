import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test as base } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  getWorkerUser,
  readClerkTestManifest,
  type ClerkTestUser,
} from "../support/clerk-test-users";

type WorkerFixtures = {
  clerkTestUser: ClerkTestUser;
  workerStorageState: string;
};

export const test = base.extend<Record<never, never>, WorkerFixtures>({
  storageState: ({ workerStorageState }, applyStorageState) =>
    applyStorageState(workerStorageState),

  clerkTestUser: [
    async ({}, applyTestUser, workerInfo) => {
      const manifest = await readClerkTestManifest();
      await applyTestUser(getWorkerUser(manifest, workerInfo.parallelIndex));
    },
    { scope: "worker" },
  ],

  workerStorageState: [
    async ({ browser, clerkTestUser }, applyStorageState, workerInfo) => {
      await clerkSetup();

      const authDirectory = path.join(workerInfo.project.outputDir, ".auth");
      const authFile = path.join(authDirectory, `${workerInfo.parallelIndex}.json`);
      const baseURL = workerInfo.project.use.baseURL;
      if (typeof baseURL !== "string") {
        throw new Error("Authenticated E2E requires a string Playwright baseURL.");
      }
      await mkdir(authDirectory, { recursive: true });

      const page = await browser.newPage({ baseURL, storageState: undefined });
      await page.goto("/");
      await clerk.signIn({ page, emailAddress: clerkTestUser.email });
      await page.goto("/dashboard");
      await expect(page.getByRole("heading", { name: /due skill/i })).toBeVisible();
      await page.context().storageState({ path: authFile });
      await page.close();

      await applyStorageState(authFile);
    },
    { scope: "worker", timeout: 90_000 },
  ],
});

export { expect } from "@playwright/test";
