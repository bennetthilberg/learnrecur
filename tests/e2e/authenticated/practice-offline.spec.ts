import { getTestPostgres } from "../support/postgres";
import { expect, test } from "../fixtures/learner-lifecycle";

for (const custom of [false, true]) {
  test(`recovers an offline ${custom ? "custom" : "normal"} save without losing the checked answer`, async ({ page, learnerFixture }) => {
    test.setTimeout(90_000);
    const sql = getTestPostgres(process.env.DATABASE_URL!);
    await page.goto(custom ? "/practice/custom" : "/practice");
    if (custom) {
      await page.getByRole("spinbutton", { name: /^Exercises/ }).fill("3");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
    }
    await expect(page.getByRole("region", { name: "Practice exercise", exact: true })).toHaveAttribute("data-next-ready", "true", { timeout: 20_000 });
    const prompt = page.locator(".practicePromptPanel");
    const before = await prompt.textContent();
    if (await page.locator(".choiceCard").count()) await page.locator(".choiceCard").first().click();
    else await page.getByLabel("Your answer", { exact: true }).fill("0");
    await page.getByRole("button", { name: "Check", exact: true }).click();
    const save = page.getByRole("button", { name: custom ? "Save practice" : "Continue", exact: true });
    await page.context().setOffline(true);
    try {
      await save.click();
      await expect(page.getByText(/Your checked answer is restored/)).toBeVisible({ timeout: 20_000 });
      await expect(prompt).toHaveText(before ?? "");
      await expect(save).toBeEnabled();
      const [row] = await sql.query('SELECT count(*)::int AS count FROM exercise_attempts WHERE "userId"=$1', [learnerFixture.userId]);
      expect(row.count).toBe(0);
    } finally { await page.context().setOffline(false); }
    await save.click();
    await expect(prompt).not.toHaveText(before ?? "", { timeout: 20_000 });
    await expect.poll(async () => (await sql.query('SELECT count(*)::int AS count FROM exercise_attempts WHERE "userId"=$1', [learnerFixture.userId]))[0].count).toBe(1);
  });
}
