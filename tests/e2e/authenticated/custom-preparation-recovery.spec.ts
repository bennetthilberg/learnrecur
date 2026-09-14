import { neon } from "@neondatabase/serverless";
import { expect, test } from "../fixtures/learner-lifecycle";

test("an empty custom session survives refresh and continues after preparation", async ({ page, learnerFixture }, testInfo) => {
  test.setTimeout(90_000);
  const sql = neon(process.env.DATABASE_URL!);
  const skill = learnerFixture.scenarios.choice;
  await sql.query('UPDATE exercises SET "retiredAt"=NOW() WHERE "skillId"=$1', [skill.skillId]);
  await page.goto(`/practice/custom?skillId=${skill.skillId}`);
  await page.getByRole("spinbutton", { name: /^Exercises\b/ }).fill("1");
  await page.getByRole("button", { name: "Start session", exact: true }).click();
  await expect(page).toHaveURL(/\/practice\?sessionId=/);
  const url = page.url();
  const sessionId = new URL(url).searchParams.get("sessionId");
  const waiting = page.getByRole("heading", { name: "No exercises are ready yet.", exact: true });
  await expect(waiting).toBeVisible();
  await page.reload();
  await expect(waiting).toBeVisible();
  const retry = page.getByRole("button", { name: "Check again", exact: true });
  await retry.click();
  await expect(page.getByRole("status").filter({ hasText: "Still waiting for exercises" })).toBeVisible();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const actions = await page.locator(".customPracticeState .practiceCompleteActions").boundingBox();
    const button = await retry.boundingBox();
    expect(Math.abs(actions!.x + actions!.width - button!.x - button!.width)).toBeLessThan(2);
    await page.locator(".customPracticeState").screenshot({ path: testInfo.outputPath(`custom-preparing-${width}.png`) });
  }
  await page.route("**/practice?sessionId=*", route => route.request().method() === "POST" ? route.abort() : route.continue(), { times: 1 });
  await retry.click();
  await expect(page.getByText("Could not check preparation. Your session is kept. Try again.")).toBeVisible();
  await expect(retry).toBeEnabled();
  await sql.query('UPDATE exercises SET "retiredAt"=NULL WHERE id=$1', [skill.exercise.id]);
  await sql.query('UPDATE users SET "dailyNewSkillLimit"=0 WHERE id=$1', [skill.userId]);
  await retry.click();
  await expect(page.getByRole("heading", { name: "Daily new-skill limit reached.", exact: true })).toBeVisible();
  await expect(retry).toBeEnabled();
  await sql.query('UPDATE users SET "dailyNewSkillLimit"=NULL WHERE id=$1', [skill.userId]);
  await retry.click();
  await expect(page.getByRole("region", { name: "Practice exercise", exact: true })).toBeVisible();
  await expect(page.getByRole("radio").first()).toBeFocused();
  expect(page.url()).toBe(url);
  const sessions = await sql.query('SELECT id,status,"completedCount" FROM practice_sessions WHERE "userId"=$1 AND id=$2', [skill.userId, sessionId]);
  expect(sessions).toEqual([{ id: sessionId, status: "ACTIVE", completedCount: 0 }]);
  expect((await sql.query('SELECT count(*)::int AS count FROM exercise_attempts WHERE "userId"=$1', [skill.userId]))[0].count).toBe(0);
});
