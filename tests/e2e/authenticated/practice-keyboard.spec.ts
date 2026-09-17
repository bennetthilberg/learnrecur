import { expect, test } from "../fixtures/learner-lifecycle";

for (const custom of [false, true]) {
  test(`keeps keyboard focus through ${custom ? "custom" : "normal"} feedback and the next question`, async ({ page, learnerFixture }, testInfo) => {
    await page.setViewportSize({ width: custom ? 390 : 1280, height: 900 });
    test.setTimeout(90_000);
    expect(learnerFixture.userId).toBeTruthy();
    await page.goto(custom ? "/practice/custom" : "/practice");
    if (custom) {
      await page.getByRole("spinbutton", { name: /^Exercises/ }).fill("3");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
    }
    const frame = page.getByRole("region", { name: "Practice exercise", exact: true });
    await expect(frame).toHaveAttribute("data-next-ready", "true", { timeout: 20_000 });
    const prompt = page.locator(".practicePromptPanel");
    const before = await prompt.textContent();
    if (await page.locator(".choiceCard").count()) await page.locator(".choiceCard").first().click();
    else await page.getByLabel("Your answer", { exact: true }).fill("0");
    await page.getByRole("button", { name: "Check", exact: true }).click();
    const advance = page.getByRole("button", { name: custom ? "Save practice" : "Continue", exact: true });
    await expect(advance).toBeFocused();
    await advance.press("Enter");
    await expect(prompt).not.toHaveText(before ?? "");
    const nextControl = (await page.locator(".choiceCard").count()) ? page.locator(".choiceCard").first() : page.getByLabel("Your answer", { exact: true });
    await expect(nextControl).toBeFocused();
    await expect(prompt).toHaveAttribute("aria-live", "polite");
    await expect(prompt).toHaveAttribute("aria-atomic", "true");
    await expect(page.getByText("Saving…", { exact: true })).toHaveCount(0, { timeout: 20_000 });
    await expect(nextControl).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("next-question-focus.png") });
  });
}

test("checks a custom typed answer with Enter and returns focus after closing a report", async ({ page, learnerFixture }) => {
  test.setTimeout(90_000);
  await page.goto(`/practice/custom?skillId=${learnerFixture.scenarios.numeric.skillId}`);
  await page.getByRole("spinbutton", { name: /^Exercises/ }).fill("1");
  await page.getByRole("button", { name: "Start session", exact: true }).click();
  const input = page.getByLabel("Your answer", { exact: true });
  await expect(input).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Report issue", exact: true }).click();
  await expect(page.getByRole("region", { name: "Report an issue" }).getByRole("checkbox").first()).toBeFocused();
  await page.getByRole("button", { name: "Close report", exact: true }).click();
  await expect(page.getByRole("button", { name: "Report issue", exact: true })).toBeFocused();
  await input.fill("0");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
  await expect(page.getByRole("button", { name: "Check", exact: true })).toBeVisible();
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Save practice", exact: true })).toBeFocused();
});


test("names confirmation close controls and restores the initiating focus", async ({ page, learnerFixture }) => {
  await page.goto("/settings");
  const deleteAccount = page.getByRole("button", { name: "Delete my account", exact: true });
  await deleteAccount.click();
  await page.getByRole("button", { name: "Close account deletion confirmation", exact: true }).click();
  await expect(deleteAccount).toBeFocused();
  await page.goto("/skills");
  const skillActions = page.getByRole("button", { name: `Open actions for ${learnerFixture.scenarios.choice.skillTitle}`, exact: true });
  await skillActions.click();
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await page.getByRole("button", { name: "Close archive confirmation", exact: true }).click();
  await expect(skillActions).toBeFocused();
});
