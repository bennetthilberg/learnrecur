import { neon } from "@neondatabase/serverless";
import { expect, test } from "../fixtures/authenticated";

test("copying practice timezone changes only the reminder draft until saved", async ({ page, clerkTestUser }, testInfo) => {
  const sql = neon(process.env.DATABASE_URL!);
  await sql.query('UPDATE users SET "practiceTimezone"=$1 WHERE id=$2', ["Asia/Kolkata", clerkTestUser.id]);
  await page.goto("/settings");
  const reminders = page.getByRole("region", { name: "Email reminders", exact: true });
  const timezone = reminders.getByRole("combobox", { name: "Timezone", exact: true });
  await expect(reminders.getByText(/Practice uses Asia\/Kolkata/)).toBeVisible();
  await reminders.getByRole("button", { name: "Use practice timezone", exact: true }).click();
  await expect(timezone).toHaveValue("Asia/Kolkata");
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await reminders.screenshot({ path: testInfo.outputPath(`reminder-timezone-${width}.png`) });
  }
  await page.reload();
  await expect(timezone).toHaveValue("Asia/Kolkata");
  await expect(reminders.getByText("Unfinished changes restored. Save to apply them.")).toBeVisible();
  await reminders.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Reminder settings saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(timezone).toHaveValue("Asia/Kolkata");
  await expect(reminders.getByRole("checkbox", { name: "Email me when practice is due" })).not.toBeChecked();
});
