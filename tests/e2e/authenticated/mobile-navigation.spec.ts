import { expect, test } from "../fixtures/authenticated";

const labels = ["Dashboard", "Practice", "History", "Skills", "Collections", "Add", "Settings"];
for (const width of [320, 390, 720, 820, 1119]) {
  test(`compact navigation exposes all pages in a stable order at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/skills");
    await expect(page.getByRole("region", { name: "Skills library", exact: true })).toBeVisible();
    const nav = page.locator(".practiceNav");
    await expect(nav).toBeHidden();
    await expect(nav.locator("a")).toHaveText(labels);
    expect(await nav.locator("a").evaluateAll((links) => links.map((link) => getComputedStyle(link).order))).toEqual(labels.map(() => "0"));
    const trigger = page.getByRole("button", { name: "Pages", exact: true });
    await expect(trigger).toBeInViewport();
    const beforeHover = await trigger.boundingBox();
    await trigger.hover();
    expect(await trigger.boundingBox()).toEqual(beforeHover);
    await trigger.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText(labels);
    await expect(menu.getByRole("menuitem", { name: "Settings", exact: true })).toBeInViewport();
    await expect(menu).toHaveCSS("opacity", "1");
    const settings = menu.getByRole("menuitem", { name: "Settings", exact: true });
    const beforeItemHover = await settings.boundingBox();
    expect(beforeItemHover!.height).toBeGreaterThanOrEqual(44);
    await settings.hover();
    expect(await settings.boundingBox()).toEqual(beforeItemHover);
    await page.screenshot({ path: testInfo.outputPath(`pages-menu-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await menu.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { name: "Settings", exact: true, level: 1 })).toBeVisible();
    await expect(nav).toBeHidden();
    await expect(nav.locator("a")).toHaveText(labels);
    expect(await nav.locator("a").evaluateAll((links) => links.map((link) => getComputedStyle(link).order))).toEqual(labels.map(() => "0"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(trigger).toBeHidden();
    await expect(nav.getByRole("link", { name: "Collections", exact: true })).toBeInViewport();
  });
}
