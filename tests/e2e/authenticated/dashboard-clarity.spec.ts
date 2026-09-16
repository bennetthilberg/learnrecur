import { expect, test } from "../fixtures/authenticated";

test("dashboard explains accuracy and collections without implying retention", async ({ page }) => {
  await page.goto("/dashboard");
  const summary = page.getByRole("region", { name: "Practice summary" });
  await expect(summary.getByText("Recent accuracy", { exact: true })).toBeVisible();
  await expect(summary.getByText(/\d+ answers? · last 14 days/)).toBeVisible();
  await expect(summary.getByText("Retention", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Manage collections" })).toHaveAttribute("href", "/collections");
  await expect(page.getByText("Instant check.", { exact: true })).toHaveCount(0);
  for (const width of [390, 1000, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});
