import { getTestPostgres } from "../support/postgres";
import { expect, test } from "../fixtures/learner-lifecycle";

test("long practice content and math remain usable with enlarged text", async ({ page, learnerFixture }, testInfo) => {
  test.setTimeout(90_000);
  const sql = getTestPostgres(process.env.DATABASE_URL!);
  const scenario = learnerFixture.scenarios.choice;
  const title = "Distinguishing permanent characteristics from temporary conditions in extended Spanish sentences";
  const layout = {
    instruction: "Choose the answer that matches the entire sentence, including the explanation in parentheses.",
    content: "Carlos y Mateo ____ médicos en el hospital general. Compare the expression $x^2 + 2x + 1$ before answering. $$1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12 = 78$$",
  };
  const label = "son — because this sentence describes their profession rather than a temporary condition or location";
  await sql.query('UPDATE skills SET title=$1 WHERE id=$2', [title, scenario.skillId]);
  await sql.query('UPDATE exercises SET prompt=$1, "generationMetadata"=$2::jsonb, choices=$3::jsonb WHERE id=$4', [
    `${layout.instruction}\n\n${layout.content}`,
    JSON.stringify({ promptLayout: layout }),
    JSON.stringify([{ id: "correct", label }, { id: "wrong", label: "están — because this answer would describe a temporary state, which is not the meaning of this sentence" }]),
    scenario.exercise.id,
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/skills/${scenario.skillId}`);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("long-skill-390.png"), fullPage: true });
  await page.goto(`/practice?collectionId=${scenario.collectionId}`);
  await expect(page.getByRole("region", { name: "Practice exercise", exact: true })).toBeVisible();
  await expect(page.locator(".katex").first()).toBeVisible();
  await expect(page.getByRole("radio").first()).toContainText(label);
  for (const enlarged of [false, true]) {
    if (enlarged) {
      // Text-only stress simulation: preserve layout width and double the computed
      // sizes of text-bearing elements. This is not an OS Dynamic Type claim.
      await page.evaluate(() => {
        const sizes = [...document.querySelectorAll<HTMLElement>(".practiceFrame *")]
          .filter(el => [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) && !el.closest(".katex"))
          .map(el => ({ el, size: parseFloat(getComputedStyle(el).fontSize) }));
        for (const { el, size } of sizes) { el.style.fontSize = `${size * 2}px`; el.style.lineHeight = "1.5"; }
      });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("radio").first().click();
    await expect(page.getByRole("radio").first()).toBeChecked();
    await page.getByRole("button", { name: /^Check/ }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: /^Check/ })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`long-practice-${enlarged ? "200-percent" : "normal"}.png`), fullPage: true });
  }
  await page.getByRole("button", { name: /^Check/ }).click();
  await expect(page.getByRole("button", { name: /^Continue/ })).toBeEnabled();
});

test("typed answers remain reachable in a keyboard-sized mobile viewport", async ({ page, learnerFixture }, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/practice?collectionId=${learnerFixture.scenarios.numeric.collectionId}`);
  const input = page.getByLabel("Your answer", { exact: true });
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.focus();
  // Approximate space left above a software keyboard; Playwright cannot open
  // the iOS keyboard or reproduce its visualViewport behavior.
  await page.setViewportSize({ width: 390, height: 430 });
  await input.scrollIntoViewIfNeeded();
  await expect(input).toBeInViewport();
  await input.fill("0");
  await expect(input).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("typed-answer-short-viewport.png") });
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeFocused();
});
