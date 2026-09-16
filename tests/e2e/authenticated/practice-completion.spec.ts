import { neon } from "@neondatabase/serverless";
import { expect, test } from "../fixtures/learner-lifecycle";

test("completion distinguishes next review, preparation, and the daily limit", async ({ page, learnerFixture }, testInfo) => {
  test.setTimeout(90_000);
  const sql = neon(process.env.DATABASE_URL!);
  const skill = learnerFixture.scenarios.choice;
  await sql.query('UPDATE skills SET "dueAt"=NOW()+INTERVAL \'1 day\' WHERE "userId"=$1', [skill.userId]);
  const url = `/practice?collectionId=${skill.collectionId}`;
  await page.goto(url);
  await expect(page.getByRole("heading", { name: /all caught up/ })).toBeVisible();
  await expect(page.getByText(/Next scheduled review:/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Custom practice", exact: true })).toHaveAttribute("href", "/practice/custom");
  for (const width of [390, 820, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const copy = await page.locator(".practiceCompleteCopy").boundingBox();
    const nextReview = await page.locator(".practiceNextReview").boundingBox();
    const actions = await page.locator(".practiceCompleteActions").boundingBox();
    expect(Math.abs(copy!.x - nextReview!.x)).toBeLessThan(1);
    expect(actions!.y).toBeGreaterThanOrEqual(copy!.y + copy!.height);
    expect(await page.locator(".practiceComplete").evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" ").length)).toBe(1);
    await page.screenshot({ path: testInfo.outputPath(`completion-${width}.png`) });
  }
  await sql.query('UPDATE skills SET "dueAt"=NOW()-INTERVAL \'1 minute\' WHERE id=$1', [skill.skillId]);
  await sql.query('UPDATE exercises SET "retiredAt"=NOW() WHERE "skillId"=$1', [skill.skillId]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Exercises need preparation.", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Check preparation", exact: true })).toHaveAttribute("href", `/skills/${skill.skillId}`);
  for (const width of [390, 820, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`preparing-${width}.png`) });
  }
  await sql.query('UPDATE users SET "dailyNewSkillLimit"=0 WHERE id=$1', [skill.userId]);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Daily new-skill limit reached.", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Change daily limit", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Custom practice", exact: true })).toBeVisible();
  for (const width of [390, 820, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`daily-limit-${width}.png`) });
  }
});
