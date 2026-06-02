import { expect, test } from "@playwright/test";

test.describe("auth spine", () => {
  test("home page points signed-out users at account creation and sign-in", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: /focused practice/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /^sign in$/i })).toHaveAttribute("href", "/sign-in");
    await expect(page.getByRole("link", { name: /create account/i })).toHaveAttribute(
      "href",
      "/sign-up",
    );
    await expect(page.getByText(/design lab has been retired/i)).toBeVisible();
    await expect(page.getByText(/canvas tint|heading weight|border radius/i)).toHaveCount(0);
  });

  test("sign-in renders the LearnRecur auth shell and Clerk form", async ({ page }) => {
    await page.goto("/sign-in");

    await expect(page.getByRole("heading", { name: /sign in to learnrecur/i })).toBeVisible();
    await expect(page.getByText(/use your development clerk account/i)).toBeVisible();
    await expect(page.getByLabel(/email address/i)).toBeVisible();
  });

  test("sign-up renders the LearnRecur auth shell and Clerk form", async ({ page }) => {
    await page.goto("/sign-up");

    await expect(page.getByRole("heading", { name: /create a learnrecur account/i })).toBeVisible();
    await expect(page.getByText(/verify clerk and database ownership/i)).toBeVisible();
    await expect(page.getByLabel(/email address/i)).toBeVisible();
  });

  test("dashboard is protected for signed-out users", async ({ page }) => {
    await page.goto("/dashboard");

    await expect(page).toHaveURL(/\/sign-in|accounts\.dev\/sign-in/);
    await expect(page.getByText(/authenticated app spine/i)).toHaveCount(0);
  });
});
