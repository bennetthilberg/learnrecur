import { expect, test } from "../fixtures/learner-lifecycle";

for (const custom of [false, true]) {
  test(`instruction hierarchy in ${custom ? "custom" : "normal"} practice`, async ({ page, learnerFixture }, testInfo) => {
    const scenario = learnerFixture.scenarios.choice;
    await page.goto(custom ? `/practice/custom?skillId=${scenario.skillId}` : `/practice?collectionId=${scenario.collectionId}`);
    if (custom) await page.getByRole("button", { name: "Start session", exact: true }).click();
    const instruction = page.locator(".practiceInstruction");
    await expect(instruction).toBeVisible();
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(instruction).toHaveCSS("font-weight", "400");
      const content = page.locator(".practicePromptPanel > p").last();
      await expect(content).toHaveCSS("font-weight", "700");
      const a = (await instruction.boundingBox())!;
      const b = (await content.boundingBox())!;
      expect(b.y - a.y - a.height).toBeCloseTo(12, 0);
      await expect(content.getByRole("img", { name: "blank" })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`prompt-${width}.png`) });
    }
    await page.locator(".choiceCard").first().click();
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await expect(page.getByRole("button", { name: custom ? "Save practice" : "Continue", exact: true })).toBeVisible();
  });
}
