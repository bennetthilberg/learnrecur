import { neon } from "@neondatabase/serverless";
import { expect, test } from "../fixtures/learner-lifecycle";

test.use({ actionTimeout: 10_000 });

for (const width of [1280, 390]) {
  test(`daily new-skill limit persists and gates practice at ${width}px`, async ({
    page,
    learnerFixture,
  }, testInfo) => {
    test.setTimeout(90_000);
    const sql = neon(process.env.DATABASE_URL!);
    const userId = learnerFixture.userId;
    const fresh = learnerFixture.scenarios.choice;
    const review = learnerFixture.scenarios.text;
    const settings = await sql.query(
      'SELECT "dailyNewSkillLimit", "practiceTimezone", "desiredRetention", "practiceDayStartMinutes" FROM users WHERE id=$1',
      [userId],
    );
    await sql.query(
      'UPDATE users SET "dailyNewSkillLimit"=NULL, "practiceTimezone"=\'UTC\' WHERE id=$1',
      [userId],
    );
    await sql.query(
      'UPDATE skills SET "dueAt"=\'2026-01-01\', repetitions=0, "lastReviewedAt"=NULL, "firstIntroducedAt"=NULL WHERE id=$1 AND "userId"=$2',
      [fresh.skillId, userId],
    );
    await sql.query(
      'UPDATE skills SET repetitions=4, "lastReviewedAt"=now()-interval \'1 day\' WHERE id=$1 AND "userId"=$2',
      [review.skillId, userId],
    );
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/settings");
      const unlimited = page.getByRole("checkbox", {
        name: "Unlimited new skills",
      });
      const limit = page.getByRole("textbox", {
        name: "New skills per day",
        exact: true,
      });
      const save = page.getByRole("button", {
        name: "Save practice preferences",
      });
      await expect(unlimited).toBeChecked();
      await expect(limit).toBeDisabled();
      await unlimited.uncheck();
      await limit.fill("0");
      await page.getByText("Advanced practice settings", { exact: true }).click();
      const timezone = page.getByRole("combobox", {
        name: "Practice timezone",
        exact: true,
      });
      await timezone.fill("America/Chicago");
      await page
        .getByRole("listbox")
        .getByRole("option", { name: "America/Chicago", exact: true })
        .click();
      await save.click();
      await expect(
        page.getByText("Preferences saved", { exact: true }),
      ).toBeVisible();
      await page.reload();
      await expect(limit).toHaveValue("0");
      await page.getByText("Advanced practice settings", { exact: true }).click();
      await expect(timezone).toHaveValue("America/Chicago");
      await page.screenshot({
        path: testInfo.outputPath(`daily-limit-settings-${width}.png`),
        fullPage: true,
      });

      const practiceUrl = `/practice?collectionId=${fresh.collectionId}`;
      let failedLoad = false;
      await page.route("**/practice?**", route => {
        if (!failedLoad && route.request().method() === "POST") {
          failedLoad = true;
          return route.abort("failed");
        }
        return route.continue();
      });
      await page.goto(practiceUrl);
      await expect(page.getByRole("heading", { name: "Could not load practice." })).toBeVisible();
      // Returning to a visible Practice tab retries a transient failed request.
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await expect(
        page.getByRole("heading", { name: "Daily new-skill limit reached." }),
      ).toBeVisible();
      await expect(
        page.getByText(/New skills are paused because your daily limit is 0/),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Change daily limit" }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`daily-limit-reached-${width}.png`),
        fullPage: true,
      });
      // The cap does not prevent a previously reviewed skill from being shown.
      await page.goto(`/practice?collectionId=${review.collectionId}`);
      await expect(page.getByRole("article")).toContainText(
        review.exercise.prompt,
      );

      await page.goto("/settings");
      await limit.fill("1");
      await save.click();
      await expect(
        page.getByText("Preferences saved", { exact: true }),
      ).toBeVisible();
      await page.goto("/dashboard");
      await expect(
        page.getByRole("heading", { name: /due skill/i }),
      ).toBeVisible();
      await page.request.get("/dashboard");
      expect(
        (
          await sql.query(
            'SELECT "firstIntroducedAt" FROM skills WHERE id=$1',
            [fresh.skillId],
          )
        )[0].firstIntroducedAt,
      ).toBeNull();
      // Rendering/prefetching an authenticated route cannot spend the allowance.
      const prefetched = await page.request.get(practiceUrl);
      expect(prefetched.ok()).toBe(true);
      expect(
        (
          await sql.query(
            'SELECT "firstIntroducedAt" FROM skills WHERE id=$1',
            [fresh.skillId],
          )
        )[0].firstIntroducedAt,
      ).toBeNull();
      await page.goto(practiceUrl);
      await expect(page.getByRole("article")).toContainText(
        fresh.exercise.prompt.replace(/_+/g, "").replace(/\s+/g, " ").trim(),
      );
      const before = (
        await sql.query(
          'SELECT "firstIntroducedAt", repetitions FROM skills WHERE id=$1',
          [fresh.skillId],
        )
      )[0];
      expect(before.firstIntroducedAt).not.toBeNull();
      expect(before.repetitions).toBe(0);
      await page.reload();
      await expect(page.getByRole("article")).toContainText(
        fresh.exercise.prompt.replace(/_+/g, "").replace(/\s+/g, " ").trim(),
      );
      expect(
        (
          await sql.query(
            'SELECT "firstIntroducedAt", repetitions FROM skills WHERE id=$1',
            [fresh.skillId],
          )
        )[0],
      ).toEqual(before);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    } finally {
      await sql.query(
        'UPDATE users SET "dailyNewSkillLimit"=$1, "practiceTimezone"=$2, "desiredRetention"=$3, "practiceDayStartMinutes"=$4 WHERE id=$5',
        [
          settings[0].dailyNewSkillLimit,
          settings[0].practiceTimezone,
          settings[0].desiredRetention,
          settings[0].practiceDayStartMinutes,
          userId,
        ],
      );
    }
  });
}

test("advanced retention and practice-day settings persist and reset", async ({
  page,
  learnerFixture,
}, testInfo) => {
  test.setTimeout(60_000);
  const sql = neon(process.env.DATABASE_URL!);
  const userId = learnerFixture.userId;
  const settings = await sql.query(
    'SELECT "desiredRetention", "practiceDayStartMinutes", "practiceTimezone" FROM users WHERE id=$1',
    [userId],
  );

  try {
    await page.goto("/settings");
    const advanced = page.getByText("Advanced practice settings", { exact: true });
    await expect(advanced).toBeVisible();
    await expect(page.locator("details.practiceAdvancedSettings")).not.toHaveAttribute(
      "open",
      "",
    );
    await advanced.click();
    await page.screenshot({
      path: testInfo.outputPath("advanced-settings-open-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: testInfo.outputPath("advanced-settings-open-mobile.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });

    const defaultRetention = page.getByRole("checkbox", {
      name: "Use default retention (90%)",
    });
    const retention = page.getByRole("textbox", {
      name: "Desired retention",
      exact: true,
    });
    await expect(defaultRetention).toBeChecked();
    await expect(retention).toBeDisabled();
    await defaultRetention.uncheck();
    await retention.fill("97.5");

    await page.getByRole("textbox", { name: "Practice day starts at", exact: true }).fill("23:45");
    const timezone = page.getByRole("combobox", {
      name: "Practice timezone",
      exact: true,
    });
    await timezone.fill("America/Chicago");
    await page
      .getByRole("listbox")
      .getByRole("option", { name: "America/Chicago", exact: true })
      .click();
    await page.getByRole("button", { name: "Save practice preferences", exact: true }).click();
    await expect(page.getByText("Preferences saved", { exact: true })).toBeVisible();

    await page.reload();
    await page.getByText("Advanced practice settings", { exact: true }).click();
    await expect(defaultRetention).not.toBeChecked();
    await expect(retention).toHaveValue("97.5%");
    await expect(
      page.getByRole("textbox", { name: "Practice day starts at", exact: true }),
    ).toHaveValue("23:45");
    await expect(timezone).toHaveValue("America/Chicago");

    await defaultRetention.check();
    await page.getByRole("button", { name: "Save practice preferences", exact: true }).click();
    await expect(page.getByText("Preferences saved", { exact: true })).toBeVisible();
    await page.reload();
    await page.getByText("Advanced practice settings", { exact: true }).click();
    await expect(defaultRetention).toBeChecked();
    await expect(retention).toBeDisabled();
  } finally {
    await sql.query(
      'UPDATE users SET "desiredRetention"=$1, "practiceDayStartMinutes"=$2, "practiceTimezone"=$3 WHERE id=$4',
      [
        settings[0].desiredRetention,
        settings[0].practiceDayStartMinutes,
        settings[0].practiceTimezone,
        userId,
      ],
    );
  }
});

test("preserves a fractional retention set outside the form during an unrelated save", async ({
  page,
  learnerFixture,
}) => {
  test.setTimeout(60_000);
  const sql = neon(process.env.DATABASE_URL!);
  const userId = learnerFixture.userId;
  const settings = await sql.query(
    'SELECT "mixedReview", "dailyNewSkillLimit", "practiceTimezone", "desiredRetention", "practiceDayStartMinutes" FROM users WHERE id=$1',
    [userId],
  );

  try {
    // Seed the value as an MCP/settings writer would: the form must not round
    // it when saving a different preference.
    await sql.query('UPDATE users SET "desiredRetention"=0.905 WHERE id=$1', [userId]);
    await page.goto("/settings");
    await page.getByText("Advanced practice settings", { exact: true }).click();
    const retention = page.getByRole("textbox", {
      name: "Desired retention",
      exact: true,
    });
    await expect(retention).toHaveValue("90.5%");

    await page.getByRole("switch", { name: "Mixed review by default" }).click();
    await page.getByRole("button", { name: "Save practice preferences", exact: true }).click();
    await expect(page.getByText("Preferences saved", { exact: true })).toBeVisible();

    await page.reload();
    await page.getByText("Advanced practice settings", { exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Desired retention", exact: true }),
    ).toHaveValue("90.5%");
    await expect(
      await sql.query('SELECT "desiredRetention" FROM users WHERE id=$1', [userId]),
    ).toEqual([{ desiredRetention: 0.905 }]);
  } finally {
    await sql.query(
      'UPDATE users SET "mixedReview"=$1, "dailyNewSkillLimit"=$2, "practiceTimezone"=$3, "desiredRetention"=$4, "practiceDayStartMinutes"=$5 WHERE id=$6',
      [
        settings[0].mixedReview,
        settings[0].dailyNewSkillLimit,
        settings[0].practiceTimezone,
        settings[0].desiredRetention,
        settings[0].practiceDayStartMinutes,
        userId,
      ],
    );
  }
});
