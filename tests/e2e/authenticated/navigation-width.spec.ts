import { clickNavigation } from "../support/navigation";
import { expect, test } from "../fixtures/learner-lifecycle";

for (const width of [390, 720, 1000, 1119, 1280]) {
  test(`navigation keeps content width at ${width}px`, async ({ page, learnerFixture }, testInfo) => {
    expect(learnerFixture.userId).toBeTruthy();
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/skills");
    for (const [destination, selector] of [["dashboard", ".openWaterHero"], ["practice", ".practiceFrame"], ["history", ".historyHeader"], ["skills", ".skillHeader"]]) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      await page.route(`**/${destination}?*`, async (route) => { await held; await route.continue(); });
      let before;
      try {
        await clickNavigation(page, destination[0].toUpperCase() + destination.slice(1));
        const pending = page.locator(`.routePendingContent[data-route-kind="${destination}"]`);
        await expect(pending.locator(selector).first()).toBeVisible();
        before = await pending.locator(selector).first().boundingBox();
        if (width === 1000) await page.screenshot({ path: testInfo.outputPath(`${destination}-pending.png`) });
      } finally { release(); }
      await expect(page.locator(".routePendingContent")).toHaveCount(0);
      await expect(page.locator(".routeSkeleton")).toHaveCount(0);
      const after = await page.locator(selector).first().boundingBox();
      if (width === 1000) await page.screenshot({ path: testInfo.outputPath(`${destination}-loaded.png`) });
      expect.soft(Math.abs(after!.x - before!.x), `${destination} left`).toBeLessThanOrEqual(1);
      expect.soft(Math.abs(after!.width - before!.width), `${destination} width`).toBeLessThanOrEqual(1);
      await page.unroute(`**/${destination}?*`);
    }
  });
}
