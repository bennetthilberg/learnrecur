import { expect, test } from "../fixtures/learner-lifecycle";

test("guidance edits survive close and refresh and clear after saving", async ({ page, learnerFixture }, testInfo) => {
  const skill = learnerFixture.scenarios.choice;
  await page.goto(`/skills/${skill.skillId}`);
  const open = () => page.getByRole("region", { name: "Practice guidance", exact: true }).getByRole("button", { name: "Edit", exact: true }).click();
  await open();
  const dialog = page.getByRole("dialog", { name: "Edit practice guidance", exact: true });
  await dialog.getByRole("textbox", { name: /^Rules/ }).fill("Read the whole sentence first.");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await open();
  await expect(dialog.getByRole("textbox", { name: /^Rules/ })).toHaveValue("Read the whole sentence first.");
  await page.reload();
  await open();
  await expect(dialog.getByRole("textbox", { name: /^Rules/ })).toHaveValue("Read the whole sentence first.");
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await dialog.getByRole("button", { name: "Save guidance", exact: true }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "Save guidance", exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`guidance-draft-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await dialog.getByRole("button", { name: "Save guidance", exact: true }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await page.reload();
  await open();
  await expect(dialog.getByRole("textbox", { name: /^Rules/ })).toHaveValue("Read the whole sentence first.");
  await expect(dialog.getByRole("button", { name: "Discard changes" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close guidance editor", exact: true }).click();
  await expect(page.getByRole("region", { name: "Practice guidance", exact: true }).getByRole("button", { name: "Edit", exact: true })).toBeFocused();
});
