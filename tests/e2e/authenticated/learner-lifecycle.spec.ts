import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";

import { expect, test } from "../fixtures/learner-lifecycle";
import { readClerkTestManifest } from "../support/clerk-test-users";
import {
  createE2EPracticeScenario,
  deleteE2EPracticeFixture,
  readE2EFlagState,
  readE2EPracticeState,
  type E2EPracticeScenarioFixture,
} from "../support/database";

test.describe("authenticated learner lifecycle", () => {
  test("opens a seeded active skill and starts collection-scoped practice", async ({
    learnerFixture,
    page,
  }) => {
    const scenario = learnerFixture.scenarios.choice;

    await page.goto(`/skills/${scenario.skillId}`);

    await expect(
      page.getByRole("heading", { name: scenario.skillTitle, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(scenario.objective, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Start practice", exact: true }),
    ).toHaveAttribute("href", "/practice");
    await expect(
      page.getByText("Exercise preparation", { exact: true }),
    ).toBeVisible();

    await page.goto(practiceUrl(scenario));

    await expect(page.getByLabel("Practice scope")).toContainText(scenario.collectionName);
    await expect(
      page.getByRole("heading", { name: scenario.skillTitle, exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("article"),
    ).toContainText(normalizeRenderedPrompt(scenario.exercise.prompt));
  });

  test("grades choice, text, numeric, and math answers and persists FSRS state", async ({
    learnerFixture,
    page,
  }) => {
    for (const kind of ["choice", "text", "numeric", "math"] as const) {
      const scenario = learnerFixture.scenarios[kind];
      const before = await readE2EPracticeState({
        exerciseId: scenario.exercise.id,
        skillId: scenario.skillId,
        userId: scenario.userId,
      });

      await completeCorrectReview(page, scenario);

      const after = await readE2EPracticeState({
        exerciseId: scenario.exercise.id,
        skillId: scenario.skillId,
        userId: scenario.userId,
      });

      expect(after.attemptCount).toBe(1);
      expect(after.reviewLogCount).toBe(1);
      expect(after.latestAttempt).toMatchObject({
        isCorrect: true,
        result: "CORRECT",
      });
      expect(after.latestAttempt?.normalizedAnswer).not.toBeNull();
      expect(after.latestReview).not.toBeNull();
      expect(after.repetitions).toBeGreaterThan(before.repetitions);
      expect(after.lastReviewedAt).not.toBeNull();
      expect(after.dueAt).not.toBeNull();
      expect(after.dueAt).not.toBe(before.dueAt);
      expect(Date.parse(after.dueAt!)).toBeGreaterThan(
        Date.parse(before.dueAt!),
      );
      expect(after.latestReview?.nextDueAt).toBe(after.dueAt);
    }
  });

  test("shows a saved review in history and exports only the learner data", async ({
    clerkTestUser,
    learnerFixture,
    page,
  }) => {
    const scenario = learnerFixture.scenarios.choice;
    const manifest = await readClerkTestManifest();
    const otherLearner = manifest.users.find((user) => user.id !== clerkTestUser.id);
    if (!otherLearner) {
      throw new Error("Export isolation requires a second Clerk test user.");
    }
    const foreignScenario = await createE2EPracticeScenario({
      email: otherLearner.email,
      kind: "choice",
      runId: `${learnerFixture.runKey}-foreign-export`,
      userId: otherLearner.id,
    });
    await completeCorrectReview(page, scenario);

    await page.goto("/history");

    const reviewRow = page
      .getByRole("row")
      .filter({ hasText: scenario.skillTitle });
    await expect(reviewRow).toBeVisible();
    await expect(reviewRow).toContainText("Correct");
    await expect(reviewRow).toContainText(/Easy|Good/);

    await reviewRow
      .getByRole("button", { name: /open review details/i })
      .click();

    const reviewDialog = page.getByRole("dialog");
    await expect(reviewDialog).toBeVisible();
    await expect(
      reviewDialog.getByRole("heading", { name: scenario.skillTitle }),
    ).toBeVisible();
    await expect(
      reviewDialog.getByText("Correct answer", { exact: true }),
    ).toBeVisible();
    await expect(
      reviewDialog.getByText(scenario.exercise.correctAnswerDisplay, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      reviewDialog.getByText("Schedule", { exact: true }),
    ).toBeVisible();
    await expect(
      reviewDialog.getByText("Memory stage", { exact: true }),
    ).toBeVisible();

    await page.goto("/settings");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download export", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(
      /^learnrecur-export-\d{4}-\d{2}-\d{2}\.json$/,
    );

    const downloadPath = await download.path();
    if (!downloadPath) {
      throw new Error(
        "The study-data export did not produce a readable download path.",
      );
    }

    const exported = JSON.parse(await readFile(downloadPath, "utf8")) as {
      exportVersion: number;
      user: { id: string };
      collections: Array<{ id: string }>;
      skills: Array<{ id: string }>;
      exercises: Array<{ id: string }>;
      exerciseAttempts: Array<{ exerciseId: string }>;
      reviewLogs: Array<{ exerciseAttemptId: string }>;
    };

    expect(exported.exportVersion).toBe(3);
    expect(exported.user.id).toBe(clerkTestUser.id);
    expect(exported.collections.map((collection) => collection.id)).toContain(
      scenario.collectionId,
    );
    expect(exported.skills.map((skill) => skill.id)).toContain(
      scenario.skillId,
    );
    expect(exported.exercises.map((exercise) => exercise.id)).toContain(
      scenario.exercise.id,
    );
    expect(exported.collections.map((collection) => collection.id)).not.toContain(
      foreignScenario.collectionId,
    );
    expect(exported.skills.map((skill) => skill.id)).not.toContain(foreignScenario.skillId);
    expect(exported.exercises.map((exercise) => exercise.id)).not.toContain(
      foreignScenario.exercise.id,
    );
    expect(
      exported.exerciseAttempts.some(
        (attempt) => attempt.exerciseId === scenario.exercise.id,
      ),
    ).toBe(true);
    expect(exported.reviewLogs.length).toBeGreaterThan(0);
    await deleteE2EPracticeFixture(foreignScenario);
  });

  test("retires a flagged exercise without saving a review and advances to its replacement", async ({
    clerkTestUser,
    learnerFixture,
    page,
  }) => {
    const scenario = await createE2EPracticeScenario({
      email: clerkTestUser.email,
      exerciseCount: 2,
      kind: "choice",
      runId: `${learnerFixture.runKey}-flag`,
      userId: clerkTestUser.id,
    });
    const [flaggedExercise, replacementExercise] = scenario.exercises;

    try {
      await page.goto(practiceUrl(scenario));
      await expect(
        page.getByRole("article"),
      ).toContainText(normalizeRenderedPrompt(flaggedExercise.prompt));
      await page.getByRole("radio", { name: /^Choice 2:/ }).click();
      await page.getByRole("button", { name: "Check", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "Not quite.", exact: true }),
      ).toBeVisible();

      await page
        .getByRole("button", { name: "Report issue", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Report an issue", exact: true }),
      ).toBeVisible();
      await page.getByLabel("Prompt is unclear").check();
      await page
        .getByRole("button", { name: "Submit report", exact: true })
        .click();

      await expect(
        page.getByText(/Exercise reported and retired from practice\./i),
      ).toBeVisible();
      await expect(
        page.getByRole("article"),
      ).toContainText(normalizeRenderedPrompt(replacementExercise.prompt));

      const flagState = await readE2EFlagState({
        exerciseId: flaggedExercise.id,
        skillId: scenario.skillId,
        userId: scenario.userId,
      });
      expect(flagState.retiredAt).not.toBeNull();
      expect(flagState.retirementReason).toBe("FLAGGED_UNCLEAR");
      expect(flagState.flagCount).toBe(1);
      expect(flagState.attemptCount).toBe(0);
      expect(flagState.reviewLogCount).toBe(0);
    } finally {
      await deleteE2EPracticeFixture(scenario);
    }
  });

  test("rejects a stale second submit without duplicating the review", async ({
    learnerFixture,
    page,
  }) => {
    const scenario = learnerFixture.scenarios.choice;
    const secondPage = await page.context().newPage();

    try {
      await Promise.all([
        page.goto(practiceUrl(scenario)),
        secondPage.goto(practiceUrl(scenario)),
      ]);
      for (const learnerPage of [page, secondPage]) {
        await expect(
          learnerPage.getByRole("heading", {
            name: scenario.skillTitle,
            exact: true,
          }),
        ).toBeVisible();
        await learnerPage.getByRole("radio", { name: /^Choice 1:/ }).click();
        await learnerPage
          .getByRole("button", { name: "Check", exact: true })
          .click();
        await expect(
          learnerPage.getByRole("heading", { name: "Correct.", exact: true }),
        ).toBeVisible();
      }

      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(
        page.getByText("Review saved.", { exact: true }),
      ).toBeVisible();

      await secondPage
        .getByRole("button", { name: "Continue", exact: true })
        .click();
      await expect(
        secondPage.getByText(
          /No eligible practice exercise was found for this user\./i,
        ),
      ).toBeVisible();

      const finalState = await readE2EPracticeState({
        exerciseId: scenario.exercise.id,
        skillId: scenario.skillId,
        userId: scenario.userId,
      });
      expect(finalState.attemptCount).toBe(1);
      expect(finalState.reviewLogCount).toBe(1);
    } finally {
      await secondPage.close();
    }
  });

  test("denies another learner's collection and skill", async ({
    clerkTestUser,
    page,
  }) => {
    const manifest = await readClerkTestManifest();
    const otherUser = manifest.users.find(
      (candidate) => candidate.id !== clerkTestUser.id,
    );
    if (!otherUser) {
      throw new Error(
        "The cross-user E2E test requires at least two Clerk test users.",
      );
    }

    const otherScenario = await createE2EPracticeScenario({
      email: otherUser.email,
      kind: "choice",
      runId: `${manifest.runId}-cross-user`,
      userId: otherUser.id,
    });

    try {
      await page.goto(practiceUrl(otherScenario));
      await expect(
        page.getByRole("heading", {
          name: "Practice is unavailable.",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByText("That collection is not available for practice.", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByText(otherScenario.skillTitle, { exact: true }),
      ).toHaveCount(0);

      await page.goto(`/skills/${otherScenario.skillId}`);
      await expect(
        page.getByRole("heading", { name: "404", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(otherScenario.skillTitle, { exact: true }),
      ).toHaveCount(0);
    } finally {
      await deleteE2EPracticeFixture(otherScenario);
    }
  });
});

async function completeCorrectReview(
  page: Page,
  scenario: E2EPracticeScenarioFixture,
) {
  await page.goto(practiceUrl(scenario));
  await expect(
    page.getByRole("heading", { name: scenario.skillTitle, exact: true }),
  ).toBeVisible();

  if (scenario.kind === "choice") {
    await page.getByRole("radio", { name: /^Choice 1:/ }).click();
  } else {
    await page.getByLabel("Your answer").fill(scenario.exercise.testAnswer);
  }

  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Correct.", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".practiceFeedbackAnswer")).toContainText(
    scenario.exercise.correctAnswerDisplay,
  );
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Review saved.", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Nice work\. You're all caught up\./i }),
  ).toBeVisible();
}

function practiceUrl(
  scenario: Pick<E2EPracticeScenarioFixture, "collectionId">,
) {
  return `/practice?collectionId=${encodeURIComponent(scenario.collectionId)}`;
}

function normalizeRenderedPrompt(prompt: string) {
  return prompt.replace(/_+/g, "").replace(/\s+/g, " ").trim();
}
