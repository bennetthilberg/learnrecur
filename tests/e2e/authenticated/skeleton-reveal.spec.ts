import { clickNavigation } from "../support/navigation";
import { expect, test } from "../fixtures/learner-lifecycle";

for (const width of [390, 1280]) {
  test(`skeleton handoffs reveal without moving or blocking content at ${width}px`, async ({ page, learnerFixture }, testInfo) => {
    test.setTimeout(90_000);
    expect(learnerFixture.userId).toBeTruthy();
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      const original = Element.prototype.animate;
      const calls: { className: string; frames: Keyframe[] }[] = [];
      Object.assign(window, { revealCalls: calls });
      Element.prototype.animate = function (frames, options) {
        calls.push({ className: this.className, frames: frames as Keyframe[] });
        const animation = original.call(this, frames, options);
        if ((window as unknown as { freezeReveal?: boolean }).freezeReveal) {
          animation.pause();
          animation.currentTime = 60;
        }
        return animation;
      };
    });
    await page.goto("/skills");
    await expect(page.locator(".routeSkeleton")).toHaveCount(0);
    await expect(page.locator(".skeletonRevealOverlay")).toHaveCount(0);
    const fastHandoffs = await page.evaluate(async () => {
      const calls = (window as unknown as { revealCalls: unknown[] }).revealCalls;
      calls.length = 0;
      const main = document.querySelector("main")!;
      const originalNow = Object.getOwnPropertyDescriptor(performance, "now");
      let elapsed = performance.now();
      Object.defineProperty(performance, "now", { configurable: true, value: () => elapsed });
      try {
        // CI frame scheduling can pause for longer than the 200ms reveal threshold.
        // Keep each synthetic load at 50ms while still letting the observer scan.
        for (let index = 0; index < 4; index++) {
          const skeleton = document.createElement("div");
          skeleton.className = "routeSkeleton";
          Object.assign(skeleton.style, { position: "fixed", top: "100px", left: "20px", width: "100px", height: "20px" });
          main.append(skeleton);
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          elapsed += 50;
          skeleton.remove();
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          elapsed += 50;
        }
      } finally {
        if (originalNow) Object.defineProperty(performance, "now", originalNow);
        else Reflect.deleteProperty(performance, "now");
      }
      return calls.length;
    });
    expect(fastHandoffs).toBe(0);
    for (const destination of ["dashboard", "history", "settings", "practice", "collections", "skills/new", "skills"]) {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      await page.route(`**/${destination}?*`, async (route) => { await held; await route.continue(); });
      await page.evaluate(() => { (window as unknown as { revealCalls: unknown[] }).revealCalls.length = 0; });
      if (destination === "skills/new") {
        // Add must also skip a reveal inherited from the page being left.
        await page.evaluate(async () => {
          const skeleton = document.createElement("div");
          skeleton.className = "routeSkeleton";
          Object.assign(skeleton.style, { position: "fixed", top: "100px", left: "20px", width: "100px", height: "20px" });
          document.querySelector("main")!.append(skeleton);
          await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 250)));
        });
      }
      let addBefore: { x: number; y: number; width: number; height: number } | null = null;
      try {
        await clickNavigation(page, destination === "skills/new" ? "Add" : destination[0].toUpperCase() + destination.slice(1));
        if (destination === "skills/new") {
          await expect(page.locator('.routePendingContent .createModeChoice')).toHaveCount(2);
          await expect(page.locator('.routePendingContent .routeSkeleton')).toHaveCount(0);
          addBefore = await page.locator('.routePendingContent .createModeChoices').boundingBox();
        } else {
          await expect(page.locator(".routePendingContent .routeSkeleton").first()).toBeVisible();
        }
        // Exercise the slow-loading path, not a near-instant cached response.
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 250))));
      } finally {
        if (destination === "settings") await page.evaluate(() => { Object.assign(window, { freezeReveal: true }); });
        release();
      }
      await expect(page.locator(".routeSkeleton")).toHaveCount(0);
      if (destination === "skills/new") {
        await expect(page.locator('.routePendingContent')).toHaveCount(0);
        const after = await page.locator('.createModeChoices').boundingBox();
        expect(after).toEqual(addBefore);
        expect(await page.evaluate(() => (window as unknown as { revealCalls: unknown[] }).revealCalls.length)).toBe(0);
        await page.screenshot({ path: testInfo.outputPath(`add-${width}.png`) });
        await page.unroute(`**/${destination}?*`);
        continue;
      }
      await expect.poll(() => page.evaluate(() => (window as unknown as { revealCalls: { className: string }[] }).revealCalls.some((call) => call.className === "skeletonRevealOverlay"))).toBe(true);
      if (destination === "settings") {
        expect(await page.locator(".skeletonRevealOverlay").evaluate((node) => getComputedStyle(node).pointerEvents)).toBe("none");
        await page.screenshot({ path: testInfo.outputPath(`reveal-${width}.png`) });
        await page.evaluate(() => {
          Object.assign(window, { freezeReveal: false });
          for (const animation of document.getAnimations()) animation.play();
        });
      }
      await expect(page.locator(".skeletonRevealOverlay")).toHaveCount(0);
      const calls = await page.evaluate(() => (window as unknown as { revealCalls: { className: string; frames: Keyframe[] }[] }).revealCalls);
      expect(calls.some((call) => call.className.includes("practiceTopbar"))).toBe(false);
      expect(calls.every((call) => call.frames.every((frame) => !("transform" in frame)))).toBe(true);
      const count = calls.length;
      await page.evaluate(() => { document.querySelector("main")?.append(document.createTextNode("")); });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await page.evaluate(() => (window as unknown as { revealCalls: unknown[] }).revealCalls.length)).toBe(count);
      await page.unroute(`**/${destination}?*`);
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => { (window as unknown as { revealCalls: unknown[] }).revealCalls.length = 0; });
    await clickNavigation(page, "Dashboard");
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.locator(".routeSkeleton")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { revealCalls: unknown[] }).revealCalls.length)).toBe(0);
    await expect(page.locator(".skeletonRevealOverlay")).toHaveCount(0);
  });
}
