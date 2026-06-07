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

  test("practice is protected for signed-out users", async ({ page }) => {
    await page.goto("/practice");

    await expect(page).toHaveURL(/\/sign-in|accounts\.dev\/sign-in/);
    await expect(page.getByText(/multiple choice/i)).toHaveCount(0);

    await page.goto("/practice?collectionId=example-collection");

    await expect(page).toHaveURL(/\/sign-in|accounts\.dev\/sign-in/);
    await expect(page.locator('[aria-label="Practice scope"]')).toHaveCount(0);
  });

  test("skill creation routes are protected for signed-out users", async ({ page }) => {
    await page.goto("/skills");

    await expect(page).toHaveURL(/\/sign-in|accounts\.dev\/sign-in/);
    await expect(page.getByText(/skill library/i)).toHaveCount(0);

    await page.goto("/skills/new");

    await expect(page).toHaveURL(/\/sign-in|accounts\.dev\/sign-in/);
    await expect(page.getByText(/create a skill draft/i)).toHaveCount(0);
    await expect(page.getByText(/paste learning material/i)).toHaveCount(0);

    await page.goto("/skills/example-skill-id");

    await expect(page).toHaveURL(/\/sign-in|accounts\.dev\/sign-in/);
    await expect(page.getByText(/review the definition/i)).toHaveCount(0);
  });

  test("collection management is protected for signed-out users", async ({ page }) => {
    await page.goto("/collections");

    await expect(page).toHaveURL(/\/sign-in|accounts\.dev\/sign-in/);
    await expect(page.getByText(/collection management/i)).toHaveCount(0);
  });

  test("reminder settings are protected for signed-out users", async ({ page }) => {
    await page.goto("/settings");

    await expect(page).toHaveURL(/\/sign-in|accounts\.dev\/sign-in/);
    await expect(page.getByText(/reminder settings/i)).toHaveCount(0);
  });

  test("practice history is protected for signed-out users", async ({ page }) => {
    await page.goto("/history");

    await expect(page).toHaveURL(/\/sign-in|accounts\.dev\/sign-in/);
    await expect(page.getByText(/review ledger/i)).toHaveCount(0);
  });
});
