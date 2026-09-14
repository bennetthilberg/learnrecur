import { neon } from "@neondatabase/serverless";
import { expect, test } from "../fixtures/learner-lifecycle";

test("skill detail shows one empty summary and only populated guidance", async ({ page, learnerFixture }, testInfo) => {
  const skill = learnerFixture.scenarios.choice;
  const sql = neon(process.env.DATABASE_URL!);
  await sql.query('UPDATE skills SET rules=NULL, examples=NULL, "exerciseConstraints"=NULL WHERE id=$1 AND "userId"=$2', [skill.skillId, skill.userId]);
  await page.goto(`/skills/${skill.skillId}`);
  const guidance = page.getByRole("region", { name: "Practice guidance", exact: true });
  await expect(guidance.getByText("No extra guidance yet. Add rules, examples, or an exercise focus with Edit.")).toBeVisible();
  await expect(guidance.getByRole("heading", { level: 3 })).toHaveCount(0);
  await expect(guidance.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  await expect(page.getByText("No completed reviews for this skill yet.", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Recent reviews", exact: true })).toHaveCount(0);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`empty-detail-${width}.png`), fullPage: true });
  }
  await sql.query('UPDATE skills SET rules=$1::jsonb WHERE id=$2 AND "userId"=$3', [JSON.stringify({ items: ["Use ser for identity."] }), skill.skillId, skill.userId]);
  await page.reload();
  await expect(guidance.getByRole("heading", { name: "Rules", exact: true })).toBeVisible();
  await expect(guidance.getByText("Use ser for identity.", { exact: true })).toBeVisible();
  await expect(guidance.getByRole("heading", { name: "Examples", exact: true })).toHaveCount(0);
  await expect(guidance.getByRole("heading", { name: "Exercise focus", exact: true })).toHaveCount(0);
  await page.goto(`/practice?collectionId=${encodeURIComponent(skill.collectionId)}`);
  await page.getByRole("radio", { name: /^Choice 1:/ }).click();
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Correct.", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Review saved.", { exact: true })).toBeVisible();
  await page.goto(`/skills/${skill.skillId}`);
  const results = page.getByRole("region", { name: "Practice results", exact: true });
  await expect(results.getByRole("heading", { name: "Choice", exact: true })).toBeVisible();
  await expect(results.getByRole("heading", { name: "Exact input", exact: true })).toHaveCount(0);
  await expect(results.getByRole("heading", { name: "Math", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Recent reviews", exact: true })).toBeVisible();
});
