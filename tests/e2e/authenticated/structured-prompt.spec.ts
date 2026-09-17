import { getTestPostgres } from "../support/postgres";
import { expect, test } from "../fixtures/learner-lifecycle";

test("structured instructions survive dashboard, practice recovery, and custom sessions", async ({ page, learnerFixture }, testInfo) => {
  test.setTimeout(90_000);
  const sql = getTestPostgres(process.env.DATABASE_URL!);
  const scenario = learnerFixture.scenarios.choice;
  const layout = { instruction: "Complétez la phrase.", content: "Carlos ____ médecin." };
  const prompt = `${layout.instruction}\n\n${layout.content}`;
  await sql.query('UPDATE skills SET "dueAt"=NOW()+INTERVAL \'1 day\' WHERE "userId"=$1 AND id<>$2', [scenario.userId, scenario.skillId]);
  await sql.query('UPDATE exercises SET prompt=$1, "generationMetadata"=$2::jsonb WHERE id=$3', [prompt, JSON.stringify({ promptLayout: layout, privateTestMetadata: "must not reach the client" }), scenario.exercise.id]);
  await page.goto('/dashboard');
  await expect(page.locator('.practiceInstruction')).toHaveText(layout.instruction, { timeout: 15_000 });
  await page.goto(`/practice?collectionId=${scenario.collectionId}`);
  await expect(page.locator('.practiceInstruction')).toHaveText(layout.instruction, { timeout: 15_000 });
  await expect(page.locator('.practicePromptPanel > p:last-child')).toContainText('Carlos');
  await page.getByRole('radio').first().click();
  await page.reload();
  await expect(page.locator('.practiceInstruction')).toHaveText(layout.instruction, { timeout: 15_000 });
  await expect(page.getByRole('radio').first()).toBeChecked();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`structured-${width}.png`) });
  }
  await page.goto(`/practice/custom?skillId=${scenario.skillId}`);
  await page.getByRole('spinbutton', { name: /^Exercises/ }).fill('1');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(page.locator('.practiceInstruction')).toHaveText(layout.instruction, { timeout: 15_000 });
  await expect(page.locator('.practicePromptPanel > p:last-child')).toContainText('Carlos');
  await page.reload();
  await expect(page.locator('.practiceInstruction')).toHaveText(layout.instruction, { timeout: 15_000 });
});
