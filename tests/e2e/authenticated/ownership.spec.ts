import { expect, test } from "../fixtures/authenticated";
import { readClerkTestManifest } from "../support/clerk-test-users";
import { createPrivateSkillFixture } from "../support/database";

test("a learner cannot open another learner's skill", async ({ clerkTestUser, page }) => {
  const manifest = await readClerkTestManifest();
  const otherUser = manifest.users.find((candidate) => candidate.id !== clerkTestUser.id);
  if (!otherUser) {
    throw new Error("The ownership test requires at least two Clerk test users.");
  }

  const skillId = await createPrivateSkillFixture({
    email: otherUser.email,
    runId: manifest.runId,
    userId: otherUser.id,
  });

  await page.goto(`/skills/${skillId}`);

  await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /page could not be found/i })).toBeVisible();
  await expect(page.getByText(/private e2e skill/i)).toHaveCount(0);
});
