import { expect, test } from "../fixtures/authenticated";

const labels = ["Dashboard", "Practice", "History", "Skills", "Collections", "Add", "Settings"];
for (const width of [390, 820, 1119]) {
  test(`compact navigation exposes all pages in a stable order at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/skills");
    await expect(page.getByRole("region", { name: "Skills library", exact: true })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Primary navigation", exact: true });
    await expect(nav.getByRole("link")).toHaveText(labels);
    expect(await nav.locator("a").evaluateAll((links) => links.map((link) => getComputedStyle(link).order))).toEqual(labels.map(() => "0"));
    const trigger = page.getByRole("button", { name: "Pages", exact: true });
    await expect(trigger).toBeInViewport();
    await trigger.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveText(labels);
    await expect(menu.getByRole("menuitem", { name: "Settings", exact: true })).toBeInViewport();
    await expect(menu).toHaveCSS("opacity", "1");
    await page.screenshot({ path: testInfo.outputPath(`pages-menu-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await menu.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { name: "Settings", exact: true, level: 1 })).toBeVisible();
    await expect(nav.getByRole("link")).toHaveText(labels);
    expect(await nav.locator("a").evaluateAll((links) => links.map((link) => getComputedStyle(link).order))).toEqual(labels.map(() => "0"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(trigger).toBeHidden();
    await expect(nav.getByRole("link", { name: "Collections", exact: true })).toBeInViewport();
  });
}
