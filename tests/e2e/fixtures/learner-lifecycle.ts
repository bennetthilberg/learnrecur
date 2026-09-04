import { test as authenticatedTest } from "./authenticated";
import {
  createLearnerLifecycleFixture,
  deleteE2EPracticeFixture,
  type E2ELearnerLifecycleFixture,
} from "../support/database";
import { readClerkTestManifest } from "../support/clerk-test-users";

type LearnerLifecycleFixtures = {
  learnerFixture: E2ELearnerLifecycleFixture;
};

export const test = authenticatedTest.extend<LearnerLifecycleFixtures>({
  learnerFixture: async ({ clerkTestUser }, provideFixture, testInfo) => {
    const manifest = await readClerkTestManifest();
    const fixture = await createLearnerLifecycleFixture({
      email: clerkTestUser.email,
      runId: `${manifest.runId}-${testInfo.testId}`,
      userId: clerkTestUser.id,
    });

    try {
      await provideFixture(fixture);
    } finally {
      await deleteE2EPracticeFixture(fixture);
    }
  },
});

export { expect } from "@playwright/test";
