import { getTestPostgres } from "../support/postgres";
import { expect, test } from "../fixtures/learner-lifecycle";
for (const { custom, scheduled } of [{ custom: false, scheduled: false }, { custom: true, scheduled: false }, { custom: true, scheduled: true }]) {
  test(`reports without answering or scheduling in ${custom ? scheduled ? "scheduled custom" : "custom" : "normal"} practice`, async ({ page, learnerFixture }, testInfo) => {
    const scenario = learnerFixture.scenarios.choice;
    const sql = getTestPostgres(process.env.DATABASE_URL!);
    const readSchedule = () => sql.query('SELECT "dueAt", repetitions, lapses, "fsrsState" FROM skills WHERE id=$1 AND "userId"=$2', [scenario.skillId, learnerFixture.userId]);
    const before = await readSchedule();
    if (custom) {
      await page.goto(`/practice/custom?skillId=${scenario.skillId}`);
      if (scheduled) await page.getByRole("radio", { name: /Scheduled review/ }).check();
      await page.getByRole("button", { name: "Start session", exact: true }).click();
    } else await page.goto(`/practice?collectionId=${scenario.collectionId}`);
    await expect(page.getByRole("button", { name: "Check", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Report issue", exact: true }).click();
    await expect(page.getByText(/Reporting does not record an answer or change your review schedule/)).toBeVisible();
    await page.getByRole("button", { name: "Close report", exact: true }).click();
    await expect(page.getByRole("button", { name: "Report issue", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Report issue", exact: true }).click();
    await page.getByRole("checkbox", { name: "Prompt is unclear", exact: true }).check();
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.getByRole("button", { name: "Submit report", exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`report-${width}.png`) });
    }
    await page.getByRole("button", { name: "Submit report", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Report an issue", exact: true })).toHaveCount(0);
    await expect.poll(async () => (await sql.query('SELECT count(*)::int AS count FROM exercise_flags WHERE "userId"=$1 AND "exerciseId" IN (SELECT id FROM exercises WHERE "skillId"=$2)', [learnerFixture.userId, scenario.skillId]))[0].count).toBe(1);
    expect(await readSchedule()).toEqual(before);
    expect((await sql.query('SELECT count(*)::int AS count FROM exercise_attempts WHERE "userId"=$1', [learnerFixture.userId]))[0].count).toBe(0);
    expect((await sql.query('SELECT count(*)::int AS count FROM review_logs WHERE "userId"=$1', [learnerFixture.userId]))[0].count).toBe(0);
    if (custom) expect(page.url()).toContain("sessionId=");
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  });
}
