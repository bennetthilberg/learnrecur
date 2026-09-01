import { clerk } from "@clerk/testing/playwright";

import { expect, test } from "../fixtures/authenticated";

test("an authenticated learner can open the core application pages", async ({ page }) => {
  const pages = [
    { path: "/dashboard", heading: /due skill/i },
    { path: "/skills", heading: /^skills$/i },
    { path: "/collections", heading: /organize practice/i },
    { path: "/history", heading: /^history$/i },
    { path: "/settings", heading: /^settings$/i },
  ];

  for (const expected of pages) {
    await page.goto(expected.path);
    await expect(page).toHaveURL(new RegExp(`${expected.path.replace("/", "\\/")}$`));
    await expect(page.getByRole("heading", { name: expected.heading }).first()).toBeVisible();
  }
});

test("signing out removes access to protected pages", async ({ page }) => {
  await page.goto("/");
  await clerk.signOut({ page });

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in|accounts\.dev\/sign-in/);
  await expect(page.getByRole("heading", { name: /due skill/i })).toHaveCount(0);
});
