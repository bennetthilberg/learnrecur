import { neon } from "@neondatabase/serverless";
import { expect, test } from "../fixtures/learner-lifecycle";
import {
  NATURAL_TEXT_POLICY,
  EXACT_TEXT_POLICY,
  textAnswerContract,
} from "../../../src/lib/practice/policies";

for (const width of [1280, 390])
  test(`retention settings and reduced-cue input at ${width}px`, async ({
    page,
    learnerFixture,
  }, testInfo) => {
    test.setTimeout(90_000);
    const sql = neon(process.env.DATABASE_URL!);
    const userId = learnerFixture.userId;
    const spanish = learnerFixture.scenarios.text;
    await page.setViewportSize({ width, height: 900 });
    await sql.query(
      'UPDATE users SET "practicePreference" = \'BALANCED\', "mixedReview" = false WHERE id = $1',
      [userId],
    );
    await sql.query(
      'UPDATE skills SET title = \'Spanish preterite formation\', "alreadyStudied" = true, repetitions = 0, "textPolicy" = $1::jsonb WHERE id = $2 AND "userId" = $3',
      [JSON.stringify(NATURAL_TEXT_POLICY), spanish.skillId, userId],
    );
    await sql.query(
      'UPDATE exercises SET prompt = \'Complete: Ayer ella ___ con Ana. (hablar, preterite)\', "answerSpec" = $1::jsonb, "correctAnswerDisplay" = \'habló\' WHERE id = $2 AND "userId" = $3',
      [
        JSON.stringify(textAnswerContract(["habló"], NATURAL_TEXT_POLICY)),
        spanish.exercise.id,
        userId,
      ],
    );
    await sql.query("UPDATE exercises SET explanation = $1 WHERE id = $2", [
      "Habló is the third-person singular preterite of hablar. The accent distinguishes it from hablo.",
      spanish.exercise.id,
    ]);
    try {
      let releaseScripts!: () => void;
      const scriptsReady = new Promise<void>((resolve) => { releaseScripts = resolve; });
      await page.route("**/_next/static/**", async (route) => {
        if (route.request().resourceType() === "script") await scriptsReady;
        await route.continue();
      });
      await page.goto("/settings", { waitUntil: "commit" });
      const preference = page.getByRole("combobox", {
        name: "Practice preference",
        exact: true,
      });
      try {
        await expect(preference).toHaveValue("BALANCED");
        // Server-rendered controls must not accept changes before React can
        // retain them. Otherwise Save can report success with the old value.
        await expect(preference).toBeDisabled();
        await expect(page.getByRole("switch", { name: "Mixed review by default" })).toBeDisabled();
        await expect(page.getByRole("button", { name: "Save practice preferences" })).toBeDisabled();
      } finally {
        releaseScripts();
        await page.unrouteAll({ behavior: "wait" });
      }
      await expect(preference).toBeEnabled();
      await preference.selectOption("RECALL_FIRST");
      await page
        .getByRole("switch", { name: "Mixed review by default" })
        .check();
      const save = page.getByRole("button", {
        name: "Save practice preferences",
      });
      // A transport failure preserves the draft options and provides a retry.
      await page.route("**/settings", (route) =>
        route.request().method() === "POST"
          ? route.abort("failed")
          : route.continue(),
      );
      await save.click();
      await expect(
        page.getByText("Could not save preferences", { exact: true }),
      ).toBeVisible();
      await page.unroute("**/settings");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/settings", async (route) => {
        if (route.request().method() === "POST") await gate;
        await route.continue();
      });
      await save.click();
      await expect(
        page.getByRole("button", { name: "Saving", exact: true }),
      ).toBeDisabled();
      await expect(preference).toBeDisabled();
      release();
      await expect(
        page.getByText("Preferences saved", { exact: true }),
      ).toBeVisible();
      await page.unroute("**/settings");
      await page.reload();
      await expect(preference).toHaveValue("RECALL_FIRST");
      await expect(
        page.getByRole("switch", { name: "Mixed review by default" }),
      ).toBeChecked();
      await page.screenshot({
        path: testInfo.outputPath(`settings-${width}.png`),
        fullPage: true,
      });
      await page.goto("/collections");
      const collectionRow = page
        .getByRole("article")
        .filter({ hasText: spanish.collectionName });
      await collectionRow
        .getByText("Practice preferences", { exact: true })
        .click();
      const collectionPreference = collectionRow.getByRole("combobox", {
        name: "Practice preference",
        exact: true,
      });
      await collectionPreference.selectOption("BALANCED");
      await collectionRow
        .getByRole("button", { name: "Save practice preferences" })
        .click();
      await expect(
        page.getByText("Preferences saved", { exact: true }),
      ).toBeVisible();
      await page.reload();
      await collectionRow
        .getByText("Practice preferences", { exact: true })
        .click();
      await expect(collectionPreference).toHaveValue("BALANCED");
      await collectionPreference.selectOption("RECALL_FIRST");
      await collectionRow
        .getByRole("button", { name: "Save practice preferences" })
        .click();
      await expect(
        page.getByText("Preferences saved", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`collection-${width}.png`),
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);

      await page.goto(`/skills/${spanish.skillId}`);
      await page.getByText("Exercise preparation", { exact: true }).click();
      const unlockCopy = page.getByText(
        "Exact input is available when suitable verified exercises are ready.",
        { exact: true },
      );
      const mathCopy = page.getByText(
        "Math input is available when suitable verified exercises are ready.",
        { exact: true },
      );
      await expect(unlockCopy).toBeAttached();
      await expect(mathCopy).toBeAttached();
      if (width >= 768) {
        await expect(unlockCopy).toBeVisible();
        await expect(mathCopy).toBeVisible();
      } else {
        // The established mobile layout hides helper copy and keeps controls.
        await expect(unlockCopy).toBeHidden();
        await expect(
          page.getByRole("button", {
            name: "Prepare exact input",
            exact: true,
          }),
        ).toBeEnabled();
        await expect(
          page.getByRole("button", { name: "Prepare math", exact: true }),
        ).toBeEnabled();
      }
      await page.getByText("Exercise preparation", { exact: true }).click();
      await page
        .getByText("Advanced practice preferences", { exact: true })
        .click();
      await expect(
        page.getByRole("combobox", {
          name: "Practice preference",
          exact: true,
        }),
      ).toHaveValue("DEFAULT");
      await expect(
        page.getByRole("checkbox", {
          name: "I have already studied this skill",
        }),
      ).toBeChecked();
      const skillPreference = page.getByRole("combobox", {
        name: "Practice preference",
        exact: true,
      });
      await skillPreference.selectOption("BALANCED");
      await page
        .getByRole("button", { name: "Save practice preferences" })
        .click();
      await expect(
        page.getByText("Preferences saved", { exact: true }),
      ).toBeVisible();
      await page.reload();
      await page
        .getByText("Advanced practice preferences", { exact: true })
        .click();
      await expect(skillPreference).toHaveValue("BALANCED");
      await skillPreference.selectOption("DEFAULT");
      await page
        .getByRole("button", { name: "Save practice preferences" })
        .click();
      await expect(
        page.getByText("Preferences saved", { exact: true }),
      ).toBeVisible();
      await page.reload();
      await page
        .getByText("Advanced practice preferences", { exact: true })
        .click();
      await expect(skillPreference).toHaveValue("DEFAULT");
      await page.screenshot({
        path: testInfo.outputPath(`skill-${width}.png`),
        fullPage: true,
      });
      await page.goto(`/practice?collectionId=${spanish.collectionId}`);
      await expect(
        page.getByRole("heading", { name: "Review", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByLabel("Practice scope", { exact: true }),
      ).toHaveCount(0);
      const mixed = page.getByRole("switch", {
        name: "Mixed review",
        exact: true,
      });
      await mixed.focus();
      await page.keyboard.press("Space");
      await expect(
        page.getByRole("heading", {
          name: "Spanish preterite formation",
          exact: true,
        }),
      ).toBeVisible();
      await page.keyboard.press("Space");
      await expect(
        page.getByRole("heading", { name: "Review", exact: true }),
      ).toBeVisible();
      // Reload starts a genuinely reduced-cue presentation after testing reversibility.
      await page.reload();
      await page.getByRole("textbox", { name: "Your answer", exact: true }).fill("hablo");
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("heading", { name: "Not quite.", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", {
          name: "Spanish preterite formation",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByLabel("Correct answer: habló", { exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`feedback-${width}.png`),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect
        .poll(async () => {
          const [row] = await sql.query(
            'SELECT "finalRating", "ratingPolicyVersion", "practiceContext", "answerPolicySnapshot" FROM exercise_attempts WHERE "exerciseId" = $1',
            [spanish.exercise.id],
          );
          return row;
        })
        .toMatchObject({
          finalRating: "AGAIN",
          ratingPolicyVersion: "correct-good-v2",
          practiceContext: {
            answerMode: "TEXT",
            mixedReview: true,
            reducedRuleCues: true,
          },
          answerPolicySnapshot: { policyVersion: 2 },
        });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    } finally {
      await sql.query(
        'UPDATE users SET "practicePreference" = \'BALANCED\', "mixedReview" = false WHERE id = $1',
        [userId],
      );
    }
  });

test("balanced math and exact technical text use the same practice flow", async ({
  page,
  learnerFixture,
}) => {
  const sql = neon(process.env.DATABASE_URL!);
  const math = learnerFixture.scenarios.math;
  await page.goto(`/practice?collectionId=${math.collectionId}`);
  await page
    .getByLabel("Your answer", { exact: true })
    .fill(math.exercise.testAnswer);
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Correct.", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Good rating, shortcut 3" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const technical = learnerFixture.scenarios.text;
  await sql.query('UPDATE skills SET "textPolicy" = $1::jsonb WHERE id = $2', [
    JSON.stringify(EXACT_TEXT_POLICY),
    technical.skillId,
  ]);
  await sql.query(
    "UPDATE exercises SET prompt = 'Write the literal toy protocol command GET /v1.', \"answerSpec\"=$1::jsonb,\"correctAnswerDisplay\"='GET /v1' WHERE id=$2",
    [
      JSON.stringify(textAnswerContract(["GET /v1"], EXACT_TEXT_POLICY)),
      technical.exercise.id,
    ],
  );
  await page.goto(`/practice?collectionId=${technical.collectionId}`);
  await page.getByLabel("Your answer", { exact: true }).fill("get  /v1");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Not quite.", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Correct answer: GET /v1", { exact: true }),
  ).toBeVisible();
});
