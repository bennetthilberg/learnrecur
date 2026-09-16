import { expect, test } from "../fixtures/authenticated";

test("first import uses the working area and readable fields at every width", async ({ page }, testInfo) => {
  await page.goto("/skills/new/multiple");
  const panel = page.getByRole("region", { name: "Add a material", exact: true });
  await expect(panel.getByRole("button", { name: "Import PDF", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Reuse a material" })).toHaveCount(0);
  for (const width of [390, 820, 1000, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.locator(".materialImportLayout").boundingBox();
    const bounds = await panel.boundingBox();
    expect(bounds!.width).toBeCloseTo(layout!.width, 0);
    const title = await panel.getByRole("textbox", { name: "Material title" }).boundingBox();
    const collection = await panel.getByRole("combobox", { name: "Collection" }).boundingBox();
    expect(title!.width).toBeGreaterThan(250);
    expect(collection!.width).toBeGreaterThan(250);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`first-import-${width}.png`), fullPage: true });
  }
  await panel.getByRole("textbox", { name: "Material title" }).fill("A readable title for a reference book");
  await page.getByRole("tab", { name: "Website", exact: true }).click();
  await expect(page.getByRole("textbox", { name: /URL/i })).toBeVisible();
});

test("collections and creation use the same product vocabulary", async ({ page }) => {
  await page.goto("/collections");
  await expect(page.getByRole("heading", { level: 1, name: "Collections", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Add a collection", exact: true })).toBeVisible();
  await expect(page.getByText(/study area/i)).toHaveCount(0);
  await page.goto("/skills/new");
  await expect(page.getByText("Materials provide source content. Skills are what you practice. Collections keep related skills together.")).toBeVisible();
});
