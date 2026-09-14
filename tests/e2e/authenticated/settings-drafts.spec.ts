import { neon } from "@neondatabase/serverless";
import { expect, test } from "../fixtures/authenticated";

test("practice edits survive navigation, failed saves and refresh without becoming saved preferences", async ({ page, clerkTestUser }, testInfo) => {
  const sql = neon(process.env.DATABASE_URL!);
  await sql.query('UPDATE users SET "dailyNewSkillLimit"=NULL WHERE id=$1', [clerkTestUser.id]);
  await page.goto("/settings");
  const form = page.getByRole("region", { name: "Practice preferences", exact: true });
  const unlimited = form.getByRole("checkbox", { name: "Unlimited new skills" });
  const limit = form.getByRole("textbox", { name: "New skills per day", exact: true });
  await expect(unlimited).toBeEnabled();
  await unlimited.uncheck();
  await limit.fill("7");
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("due skill");
  await page.goBack();
  await expect(limit).toHaveValue("7");
  await expect(form.getByText("Unfinished changes restored. Save to apply them.")).toBeVisible();
  expect(await sql.query('SELECT "dailyNewSkillLimit" FROM users WHERE id=$1', [clerkTestUser.id])).toEqual([{ dailyNewSkillLimit: null }]);
  let fail = true;
  await page.route("**/settings", route => {
    if (fail && route.request().method() === "POST") { fail = false; return route.abort(); }
    return route.continue();
  });
  await form.getByRole("button", { name: "Save practice preferences" }).click();
  await expect(page.getByText("Could not save preferences", { exact: true })).toBeVisible();
  await page.reload();
  await expect(limit).toHaveValue("7");
  await form.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(limit).toHaveValue("Unlimited");
  await page.reload();
  await expect(limit).toHaveValue("Unlimited");
  await expect(unlimited).toBeEnabled();
  await unlimited.uncheck();
  await limit.fill("9");
  await page.setViewportSize({ width: 390, height: 900 });
  await form.screenshot({ path: testInfo.outputPath("settings-draft-390.png") });
  await form.getByRole("button", { name: "Save practice preferences" }).click();
  await expect(page.getByText("Preferences saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(limit).toHaveValue("9");
  await expect(form.getByRole("button", { name: "Discard changes", exact: true })).toHaveCount(0);
});

test("reminder drafts retain hour and threshold independently of saved email preferences", async ({ page }) => {
  await page.goto("/settings");
  const form = page.getByRole("region", { name: "Email reminders", exact: true });
  const count = form.getByRole("spinbutton", { name: "Minimum due skills", exact: true });
  await expect(count).toBeEnabled();
  await count.fill("6");
  await page.reload();
  await expect(count).toHaveValue("6");
  await expect(form.getByText("Unfinished changes restored. Save to apply them.")).toBeVisible();
  await form.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Reminder settings saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(count).toHaveValue("6");
  await expect(form.getByRole("button", { name: "Discard changes", exact: true })).toHaveCount(0);
  await expect(form.getByRole("checkbox", { name: "Email me when practice is due" })).not.toBeChecked();
});

test("retains edits through browser Back when tab storage is unavailable", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("learnrecur:form:")) throw new DOMException("Storage unavailable", "QuotaExceededError");
      return set.call(this, key, value);
    };
  });
  await page.goto("/settings");
  const form = page.getByRole("region", { name: "Email reminders", exact: true });
  const count = form.getByRole("spinbutton", { name: "Minimum due skills", exact: true });
  await expect(count).toBeEnabled();
  const initial = await count.inputValue();
  await count.fill("8");
  await expect(form.getByText(/Save before refreshing or closing this tab/)).toBeVisible();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goBack();
  await expect(count).toHaveValue("8");
  await expect(form.getByText(/Save before refreshing or closing this tab/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 900 });
  await form.screenshot({ path: testInfo.outputPath("memory-draft-390.png") });
  await form.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(count).toHaveValue(initial);
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goBack();
  await expect(count).toHaveValue(initial);
});
