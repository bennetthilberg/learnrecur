import { expect, test } from "../fixtures/authenticated";

test("compact header centers its brand navigation and avatar", async ({ page }, testInfo) => {
  await page.goto("/practice");
  await expect(page.locator(".learnrecurUserAvatar")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  for (const width of [390, 719, 720, 1000, 1119, 1120]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`header-${width}.png`) });
    const brand = await page.locator(".practiceWordmark").boundingBox();
    const avatar = await page.locator(".learnrecurUserAvatar").boundingBox();
    const center = (box: { y: number; height: number }) => box.y + box.height / 2;
    if (width < 1120) {
      expect(Math.abs(center(brand!) - center(avatar!)), `brand/avatar at ${width}`).toBeLessThanOrEqual(1);
      if (width >= 720) {
        for (const label of await page.locator(".practiceNavLabel").all()) {
          expect(Math.abs(center((await label.boundingBox())!) - center(brand!)), `nav/brand at ${width}`).toBeLessThanOrEqual(1);
        }
      }
    } else {
      expect(avatar!.y).toBeGreaterThan(brand!.y);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});
