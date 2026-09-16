import { expect, test } from "../fixtures/learner-lifecycle";

for (const width of [390, 1280]) {
  test(`branded selects support keyboard and form values at ${width}px`, async ({ page, learnerFixture }, testInfo) => {
    expect(learnerFixture.userId).toBeTruthy();
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/settings");
    const preference = page.getByRole("combobox", { name: "Practice preference", exact: true });
    await preference.click();
    const option = page.getByRole("option", { name: "Recall first", exact: true });
    await expect(option).toBeVisible();
    await expect(option).toHaveClass(/appSelectOption/);
    expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath("preference-open.png") });
    await preference.press("Escape");
    await expect(option).toBeHidden();
    await expect(preference).toBeFocused();
    await preference.press("ArrowDown");
    await preference.press("ArrowDown");
    await preference.press("Enter");
    await expect(preference).toHaveValue("Recall first");
    await page.getByRole("button", { name: "Save practice preferences", exact: true }).click();
    await expect(page.locator(".learnrecurNotification")).toContainText(/saved/i);
    await page.reload();
    await expect(preference).toHaveValue("Recall first");
    const hour = page.getByRole("combobox", { name: "Local hour", exact: true });
    await hour.click();
    await page.getByRole("option", { name: "9 AM", exact: true }).click();
    await expect(page.locator('input[type="hidden"][name="localHour"]')).toHaveValue("9");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
