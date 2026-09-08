import { expect, test } from "../fixtures/authenticated";

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`opens needs attention with a useful empty or findings state on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/practice/attention");

    await expect(page).toHaveURL(/\/practice\/attention$/);
    await expect(page.getByRole("heading", { name: /^needs attention$/i })).toBeVisible();
    await expect(page.locator(".routeSkeleton")).toHaveCount(0);
    await expect(
      page.locator('[data-testid="needs-attention-item"], .practiceAttentionEmpty').first(),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Open practice" }).first()).toHaveAttribute(
      "href",
      "/practice",
    );
    const repeatedMiss = page.locator('[data-kind="repeated-misses"]').first();
    if (await repeatedMiss.count()) {
      await expect(repeatedMiss.getByRole("link", { name: "Practice this skill" })).toHaveAttribute(
        "href",
        /\/practice\/custom\?skillId=.+/,
      );
    }
    await expect(page.getByRole("link", { name: "Browse skills" }).first()).toHaveAttribute(
      "href",
      "/skills",
    );
    await page.screenshot({
      path: testInfo.outputPath(`needs-attention-${viewport.name}.png`),
      fullPage: true,
    });
  });
}

test("returns to the first page for a malformed needs-attention cursor", async ({ page }) => {
  await page.goto("/practice/attention?cursor=not-base64-json");

  await expect(page).toHaveURL(/\/practice\/attention$/);
  await expect(page.getByRole("heading", { name: /^needs attention$/i })).toBeVisible();
});
