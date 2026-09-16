import type { Page } from "@playwright/test";

export async function clickNavigation(page: Page, label: string) {
  const menu = page.getByRole("button", { name: "Pages", exact: true });
  if (await menu.isVisible()) {
    await menu.click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
  } else {
    await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: label, exact: true }).click();
  }
}
