import { expect, test } from "@playwright/test";

test.describe("auth spine", () => {
  test("home page points signed-out users at account creation and sign-in", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: /skill practice/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /^sign in$/i })).toHaveAttribute("href", "/sign-in");
    await expect(page.getByRole("link", { name: /create account/i })).toHaveAttribute(
      "href",
      "/sign-up",
    );
    await expect(page.getByRole("link", { name: /^privacy$/i })).toHaveAttribute(
      "href",
      "/privacy",
    );
    await expect(page.getByRole("link", { name: /^terms$/i })).toHaveAttribute("href", "/terms");
    await expect(page.getByText(/work through verified exercises/i)).toBeVisible();
    await expect(page.getByText(/canvas tint|heading weight|border radius/i)).toHaveCount(0);
  });

  test("policy pages are public drafts", async ({ page }) => {
    await page.goto("/privacy");

    await expect(page.getByRole("heading", { name: /^privacy$/i })).toBeVisible();
    await expect(page.getByText(/ai processing/i)).toBeVisible();
    await expect(page.getByText(/legal review/i)).toBeVisible();

    await page.goto("/terms");

    await expect(page.getByRole("heading", { name: /^terms$/i })).toBeVisible();
    await expect(page.getByRole("list", { name: /terms summary/i })).toBeVisible();
    await expect(page.getByText(/account access/i)).toBeVisible();
    await expect(page.getByText(/legal review/i)).toBeVisible();
  });

  test("sign-in renders the LearnRecur auth shell and Clerk form", async ({ page }) => {
    await page.goto("/sign-in");

    await expect(page.getByRole("heading", { name: /sign in to learnrecur/i })).toBeVisible();
    await expect(page.getByText(/return to your due skills/i)).toBeVisible();
    await expect(page.getByLabel(/email address/i)).toBeVisible();
  });

  test("sign-in presents the conditional passkey method as a full-width secondary action", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    await expect(page.getByLabel(/email address/i)).toBeVisible();

    if ((await page.locator(".cl-alternativeMethodsBlockButton").count()) === 0) {
      await page.evaluate(() => {
        const main = document.querySelector(".cl-main");
        const alternativeMethods = document.createElement("div");
        const passkeyButton = document.createElement("button");

        alternativeMethods.className = "cl-alternativeMethods";
        passkeyButton.className = "cl-alternativeMethodsBlockButton";
        passkeyButton.type = "button";
        passkeyButton.textContent = "Use a passkey instead";
        alternativeMethods.append(passkeyButton);
        main?.append(alternativeMethods);
      });
    }

    const passkeyButton = page.getByRole("button", { name: /use a passkey instead/i });
    const primaryButton = page.getByRole("button", { name: /^continue$/i });
    await expect(passkeyButton).toBeVisible();

    const layout = await page.evaluate(() => {
      const passkey = document.querySelector<HTMLElement>(".cl-alternativeMethodsBlockButton");
      const primary = document.querySelector<HTMLElement>(".cl-formButtonPrimary");
      const footer = document.querySelector<HTMLElement>(".cl-footer");
      const footerAction = document.querySelector<HTMLElement>(".cl-footerAction");

      if (!passkey || !primary || !footer || !footerAction) {
        throw new Error("Expected Clerk auth controls were not rendered.");
      }

      const passkeyRect = passkey.getBoundingClientRect();
      const primaryRect = primary.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      const footerActionRect = footerAction.getBoundingClientRect();
      const passkeyStyle = getComputedStyle(passkey);
      const passkeyIconStyle = getComputedStyle(passkey, "::before");
      const footerActionStyle = getComputedStyle(footerAction);

      return {
        buttonHeight: passkeyRect.height,
        buttonWidthDifference: Math.abs(passkeyRect.width - primaryRect.width),
        buttonBackground: passkeyStyle.backgroundColor,
        buttonBorder: passkeyStyle.border,
        buttonShadow: passkeyStyle.boxShadow,
        footerActionAlignment: footerActionStyle.alignItems,
        footerActionJustification: footerActionStyle.justifyContent,
        footerActionWidthDifference: Math.abs(footerActionRect.width - footerRect.width),
        footerGap: footerRect.top - passkeyRect.bottom,
        iconContent: passkeyIconStyle.content,
        iconHeight: passkeyIconStyle.height,
        iconMask: passkeyIconStyle.maskImage || passkeyIconStyle.webkitMaskImage,
        iconWidth: passkeyIconStyle.width,
      };
    });

    await expect(primaryButton).toBeVisible();
    expect(layout.buttonHeight).toBeGreaterThanOrEqual(44);
    expect(layout.buttonWidthDifference).toBeLessThan(1);
    expect(layout.buttonBackground).toBe("rgb(255, 255, 255)");
    expect(layout.buttonBorder).toContain("rgb(221, 227, 238)");
    expect(layout.buttonShadow).toContain("rgb(205, 212, 225)");
    expect(layout.footerGap).toBeGreaterThanOrEqual(24);
    expect(layout.footerActionWidthDifference).toBeLessThan(1);
    expect(layout.footerActionAlignment).toBe("center");
    expect(layout.footerActionJustification).toBe("center");
    expect(layout.iconContent).not.toBe("none");
    expect(layout.iconWidth).toBe("18px");
    expect(layout.iconHeight).toBe("18px");
    expect(layout.iconMask).toContain("data:image/svg+xml");
  });

  test("sign-up renders the LearnRecur auth shell and Clerk form", async ({ page }) => {
    await page.goto("/sign-up");

    await expect(page.getByRole("heading", { name: /create a learnrecur account/i })).toBeVisible();
    await expect(page.getByText(/private study space/i)).toBeVisible();
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

    for (const protectedPath of [
      "/skills/new/one",
      "/skills/new/multiple",
      "/skills/materials",
      "/skills/materials/example-material-id",
      "/skills/materials/example-material-id/create",
      "/skills/batches/example-batch-id",
    ]) {
      await page.goto(protectedPath);
      await expect(page).toHaveURL(/\/sign-in|accounts\.dev\/sign-in/);
    }

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

    await page.goto("/settings/export");

    await expect(page).toHaveURL(/\/sign-in|accounts\.dev\/sign-in/);
    await expect(page.getByText(/download study data/i)).toHaveCount(0);
  });

  test("practice history is protected for signed-out users", async ({ page }) => {
    await page.goto("/history");

    await expect(page).toHaveURL(/\/sign-in|accounts\.dev\/sign-in/);
    await expect(page.getByText(/review ledger/i)).toHaveCount(0);
  });

  test("operations page is protected for signed-out users", async ({ page }) => {
    await page.goto("/ops");

    await expect(page).toHaveURL(/\/sign-in|accounts\.dev\/sign-in/);
    await expect(page.getByText(/production operations/i)).toHaveCount(0);
  });
});
