import { neon } from "@neondatabase/serverless";
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
      page.getByRole("link", { name: "Practice this skill", exact: true }),
    ).toHaveAttribute("href", `/practice/custom?skillId=${scenario.skillId}`);
    await expect(
      page.getByText("Exercise preparation", { exact: true }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Practice this skill", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: new RegExp(scenario.skillTitle) })).toBeChecked();

    await page.goto(practiceUrl(scenario));

    await expect(page.getByLabel("Practice scope")).not.toContainText(scenario.collectionName);
    await expect(
      page.getByRole("region", { name: "Practice exercise", exact: true }),
    ).toBeVisible();
    await expect.poll(async () => normalizeRenderedPrompt((await page.locator(".practicePromptPanel p").allTextContents()).join(" ")))
      .toBe(normalizeRenderedPrompt(scenario.exercise.prompt));
  });

  // Each answer kind gets its own fixture and deadline; four remote-backed
  // practice flows can exceed one shared 30-second budget on a slow CI runner.
  for (const kind of ["choice", "text", "numeric", "math"] as const) {
    test(`grades ${kind} answers and persists FSRS state`, async ({
      learnerFixture,
      page,
    }) => {
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
    });
  }

  test("finds older mistakes with filters and load more", async ({ learnerFixture, page }) => {
    test.setTimeout(60_000);
    const scenario = learnerFixture.scenarios.choice;
    await completeCorrectReview(page, scenario);
    const sql = neon(process.env.DATABASE_URL!);
    await sql.query(`INSERT INTO exercise_attempts SELECT (jsonb_populate_record(NULL::exercise_attempts,
      to_jsonb(a) || jsonb_build_object('id', a.id || '-history-' || n, 'result', 'INCORRECT', 'isCorrect', false))).*
      FROM exercise_attempts a CROSS JOIN generate_series(1, 51) n
      WHERE a."skillId"=$1 AND a."userId"=$2`, [scenario.skillId, learnerFixture.userId]);
    await sql.query(`INSERT INTO review_logs SELECT (jsonb_populate_record(NULL::review_logs,
      to_jsonb(r) || jsonb_build_object('id', r.id || '-history-' || n, 'exerciseAttemptId', r."exerciseAttemptId" || '-history-' || n))).*
      FROM review_logs r CROSS JOIN generate_series(1, 51) n
      WHERE r."skillId"=$1 AND r."userId"=$2`, [scenario.skillId, learnerFixture.userId]);
    await page.goto("/history");
    await expect(page.getByRole("status").filter({ hasText: "Showing 50 reviews" })).toBeVisible();
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Showing 52 reviews" })).toBeVisible();
    await page.getByRole("combobox", { name: "Skill", exact: true }).click();
    await page.getByRole("option", { name: scenario.skillTitle, exact: true }).click();
    await page.getByRole("combobox", { name: "Collection", exact: true }).click();
    await page.getByRole("option", { name: scenario.collectionName, exact: true }).click();
    await page.getByRole("checkbox", { name: "Incorrect answers only" }).check();
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page.locator(".historySimpleTable tbody tr")).toHaveCount(50);
    await expect(page.locator(".historyResultBadge").first()).toHaveText("Incorrect");
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await expect(page.locator(".historySimpleTable tbody tr")).toHaveCount(51);
    await expect(page.getByRole("button", { name: "Load more", exact: true })).toHaveCount(0);
    for (const width of [390, 1000, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const label = page.locator(".historyResultBadge .mantine-Badge-label").first();
      expect(await label.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
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
    try {
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
      reviewDialog.getByRole("region", { name: "Correct answer", exact: true }).getByText(scenario.exercise.correctAnswerDisplay, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(reviewDialog.getByRole("region", { name: "Your answer", exact: true })).toContainText(scenario.exercise.correctAnswerDisplay);
    await expect(reviewDialog.getByRole("region", { name: "Question", exact: true })).toContainText(normalizeRenderedPrompt(scenario.exercise.prompt));
    await expect(reviewDialog.getByRole("button", { name: "Close review details" })).toBeVisible();
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

    // Downloading must not change the client router's action endpoint. Both
    // export links leave settings interactive, including account deletion.
    for (const linkName of [null, "Download export first"] as const) {
      if (linkName) {
        const anotherDownload = page.waitForEvent("download");
        await page.getByRole("link", { name: linkName, exact: true }).click();
        await anotherDownload;
      }
      await expect(page).toHaveURL(/\/settings$/);
      await page.getByRole("combobox", { name: "Practice preference", exact: true }).click();
      await page.getByRole("option", { name: "Recall first", exact: true }).click();
      await page.getByRole("button", { name: "Save practice preferences", exact: true }).click();
      await expect(page.getByText("Preferences saved", { exact: true })).toBeVisible();
    }

    expect(exported.exportVersion).toBe(6);
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
    } finally {
      await deleteE2EPracticeFixture(foreignScenario);
    }
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
      await expect.poll(async () => normalizeRenderedPrompt((await page.locator(".practicePromptPanel p").allTextContents()).join(" ")))
        .toBe(normalizeRenderedPrompt(flaggedExercise.prompt));
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
      await expect.poll(async () => normalizeRenderedPrompt((await page.locator(".practicePromptPanel p").allTextContents()).join(" ")))
        .toBe(normalizeRenderedPrompt(replacementExercise.prompt));

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
          learnerPage.getByRole("region", {
            name: "Practice exercise",
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
    page.getByRole("region", { name: "Practice exercise", exact: true }),
  ).toBeVisible();

  if (scenario.kind === "choice") {
    await page.getByRole("radio", { name: /^Choice 1:/ }).click();
  } else {
    await page.getByLabel("Your answer").fill(scenario.exercise.testAnswer);
  }

  // Feedback must not depend on authentication or a database round trip.
  await page.context().setOffline(true);
  try {
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Correct.", exact: true })).toBeVisible({ timeout: 500 });
  } finally {
    await page.context().setOffline(false);
  }
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
