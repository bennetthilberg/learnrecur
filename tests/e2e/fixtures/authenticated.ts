import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { expect, test as base } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  getWorkerUser,
  readClerkTestManifest,
  type ClerkTestUser,
} from "../support/clerk-test-users";

type AuthenticatedFixtures = {
  authenticatedStorageState: string;
};

type WorkerFixtures = {
  clerkTestUser: ClerkTestUser;
};

export const test = base.extend<AuthenticatedFixtures, WorkerFixtures>({
  storageState: ({ authenticatedStorageState }, applyStorageState) =>
    applyStorageState(authenticatedStorageState),

  clerkTestUser: [
    async ({}, applyTestUser, workerInfo) => {
      const manifest = await readClerkTestManifest();
      await applyTestUser(getWorkerUser(manifest, workerInfo.parallelIndex));
    },
    { scope: "worker" },
  ],

  authenticatedStorageState: async ({ browser, clerkTestUser }, applyStorageState, testInfo) => {
    await clerkSetup();

    const authDirectory = path.join(testInfo.outputDir, ".auth");
    const authFile = path.join(authDirectory, "session.json");
    const baseURL = testInfo.project.use.baseURL;
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
});

export { expect } from "@playwright/test";
