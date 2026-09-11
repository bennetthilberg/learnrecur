import { expect, test } from "../fixtures/learner-lifecycle";

for (const width of [1280, 390]) {
  test(`loading geometry and action alignment at ${width}px`, async ({ page, learnerFixture }, testInfo) => {
    test.setTimeout(90_000);
    expect(learnerFixture.scenarios.choice.skillId).toBeTruthy();
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/skills");
    await expect(page.locator(".routeSkeleton")).toHaveCount(0);
    for (const destination of ["dashboard", "practice"]) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      await page.route(`**/${destination}?*`, async (route) => {
        await held;
        await route.continue();
      });
      await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: destination === "dashboard" ? "Dashboard" : "Practice", exact: true }).click();
      const pending = page.locator(`.routePendingContent[data-route-kind="${destination}"]`);
      await expect(pending).toBeVisible();
      const selectors = destination === "dashboard"
        ? [".openWaterHero", ".openWaterStatGrid", ".openWaterReviewCard", ".openWaterHeroActions > :first-child", ".openWaterReviewActions > :first-child"]
        : [".practiceToolbar", ".practiceFrame", ".practiceMetaRow", ".practicePromptPanel"];
      const before = await Promise.all(selectors.map((selector) => pending.locator(selector).boundingBox()));
      const shimmer = pending.locator(".routeSkeleton").first();
      expect(await shimmer.evaluate((node) => getComputedStyle(node, "::after").animationName)).toBe("route-skeleton-shimmer");
      const initialTransform = await shimmer.evaluate((node) => getComputedStyle(node, "::after").transform);
      await expect.poll(() => shimmer.evaluate((node) => getComputedStyle(node, "::after").transform)).not.toBe(initialTransform);
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await shimmer.evaluate((node) => getComputedStyle(node, "::after").animationName)).toBe("none");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await expect(pending.getByText("Loading practice…", { exact: true })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`${destination}-loading-${width}.png`) });
      release();
      await expect(pending).toHaveCount(0);
      await expect(page.locator(".routeSkeleton")).toHaveCount(0);
      await page.unroute(`**/${destination}?*`);
      for (let i = 0; i < selectors.length; i++) {
        const after = await page.locator(selectors[i]).boundingBox();
        expect(Math.abs(after!.x - before[i]!.x), `${destination} ${selectors[i]} x`).toBeLessThanOrEqual(4);
        // These two positions follow variable-length skill names or exercise text.
        // Their horizontal alignment stays fixed; the enclosing sections must not shift.
        if (![".practicePromptPanel", ".openWaterReviewActions > :first-child"].includes(selectors[i])) {
          expect(Math.abs(after!.y - before[i]!.y), `${destination} ${selectors[i]} y`).toBeLessThanOrEqual(4);
        }
        expect(Math.abs(after!.width - before[i]!.width), `${destination} ${selectors[i]} width`).toBeLessThanOrEqual(4);
        if ([".openWaterHero", ".openWaterStatGrid", ".practiceFrame"].includes(selectors[i])) {
          expect(Math.abs(after!.height - before[i]!.height), `${destination} ${selectors[i]} height`).toBeLessThanOrEqual(4);
        }
      }
      await page.screenshot({ path: testInfo.outputPath(`${destination}-ready-${width}.png`) });
    }
    const scope = page.locator(".practiceScopeBar");
    const identity = await scope.locator(".practiceScopeIdentity").boundingBox();
    for (const name of ["Custom session", "Needs attention"]) {
      const link = await scope.getByRole("link", { name, exact: true }).boundingBox();
      expect(Math.abs((link!.y + link!.height / 2) - (identity!.y + identity!.height / 2))).toBeLessThanOrEqual(2);
    }
    await expect(page.getByRole("button", { name: "About mixed review" })).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Mixed review", exact: true })).toHaveCount(0);
    await page.goto("/practice/custom");
    await expect(page.getByRole("button", { name: "Start session" })).toBeEnabled();
    const primary = await page.getByRole("button", { name: "Start session" }).boundingBox();
    const secondary = await page.getByRole("link", { name: "Cancel", exact: true }).boundingBox();
    expect(primary!.x).toBeGreaterThan(secondary!.x);
    if (width > 760) {
      const columns = await page.locator(".customPracticeSetupGrid").evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").map(parseFloat));
      expect(columns[1] / columns[0]).toBeGreaterThan(.8);
    }
    const legend = page.locator(".customPracticeSkillFieldset legend");
    expect(await legend.locator("small").evaluate((node) => getComputedStyle(node).display)).toBe("block");
    expect(await page.locator(".customPracticeSkillList input").count()).toBeGreaterThan(0);
    const skillRows = await page.locator(".customPracticeSkillList label").evaluateAll((rows) => rows.map((row) => {
      const rect = row.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, contentBottom: row.querySelector("span")!.getBoundingClientRect().bottom };
    }));
    for (let i = 0; i < skillRows.length; i++) {
      expect(skillRows[i].contentBottom).toBeLessThanOrEqual(skillRows[i].bottom + 1);
      if (i > 0) expect(skillRows[i].top).toBeGreaterThanOrEqual(skillRows[i - 1].bottom + 8);
    }
    await page.screenshot({ path: testInfo.outputPath(`custom-ready-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
