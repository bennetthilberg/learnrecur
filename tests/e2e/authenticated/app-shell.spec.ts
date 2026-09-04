import { clerk } from "@clerk/testing/playwright";

import { expect, test } from "../fixtures/authenticated";

test("an authenticated learner can open the core application pages", async ({ page }) => {
  test.setTimeout(60_000);
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /hydration failed/i.test(message.text())) {
      hydrationErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    if (/hydration failed/i.test(error.message)) hydrationErrors.push(error.message);
  });
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
  expect(hydrationErrors).toEqual([]);
});

test("signing out removes access to protected pages", async ({ page }) => {
  await page.goto("/");
  await clerk.signOut({ page });

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in|accounts\.dev\/sign-in/);
  await expect(page.getByRole("heading", { name: /due skill/i })).toHaveCount(0);
});
