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
      'SELECT "dailyNewSkillLimit", "practiceTimezone" FROM users WHERE id=$1',
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
      const timezone = page.getByRole("combobox", {
        name: "Daily reset timezone",
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
      await expect(timezone).toHaveValue("America/Chicago");
      await page.screenshot({
        path: testInfo.outputPath(`daily-limit-settings-${width}.png`),
        fullPage: true,
      });

      const practiceUrl = `/practice?collectionId=${fresh.collectionId}`;
      await page.goto(practiceUrl);
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
        'UPDATE users SET "dailyNewSkillLimit"=$1, "practiceTimezone"=$2 WHERE id=$3',
        [settings[0].dailyNewSkillLimit, settings[0].practiceTimezone, userId],
      );
    }
  });
}
