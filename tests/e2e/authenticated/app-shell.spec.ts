import { clerk } from "@clerk/testing/playwright";

import { expect, test } from "../fixtures/authenticated";

const hydrationError = /hydrat|Minified React error #(?:418|423|425)/i;

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`an authenticated learner can open the core application pages on ${viewport.name}`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    const hydrationErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && hydrationError.test(message.text())) {
        hydrationErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      if (hydrationError.test(error.message)) hydrationErrors.push(error.message);
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
      // Loading shells include the page title too; wait for the real content.
      await expect(page.locator(".routeSkeleton")).toHaveCount(0);
      // A heading can appear before Clerk finishes mounting the account widget.
      await clerk.loaded({ page });
      await expect(page.locator(".learnrecurUserButton")).toBeVisible();
      expect(hydrationErrors, `hydration errors on ${expected.path}`).toEqual([]);
    }

    const identity = page.getByRole("button", { name: /open account menu for/i });
    await (await identity.isVisible() ? identity : page.locator(".learnrecurUserButton")).click();
    await expect(page.getByRole("button", { name: /manage account/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`account-menu-${viewport.name}.png`),
      animations: "disabled",
    });
    expect(hydrationErrors).toEqual([]);
  });
}

test("signing out removes access to protected pages", async ({ page }) => {
  await page.goto("/");
  await clerk.signOut({ page });

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in|accounts\.dev\/sign-in/);
  await expect(page.getByRole("heading", { name: /due skill/i })).toHaveCount(0);
});
