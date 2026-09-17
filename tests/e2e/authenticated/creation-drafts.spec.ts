import { clickNavigation } from "../support/navigation";
import { expect, test } from "../fixtures/authenticated";

test("unfinished source text and context survive refresh and navigation", async ({ page }, testInfo) => {
  await page.goto("/skills/new/one");
  const text = page.getByRole("textbox", { name: "Add learning material", exact: true });
  await expect(text).toBeEnabled();
  await text.fill("Practice choosing ser or estar from context.");
  await page.locator("form.createSkillMaterialForm:visible").getByText("More options", { exact: true }).click();
  await page.getByRole("textbox", { name: "Collection", exact: true }).fill("Spanish grammar");
  await page.getByRole("textbox", { name: "Source name", exact: true }).fill("Chapter 4");
  await page.getByRole("textbox", { name: "Focus", exact: true }).fill("Use short sentences.");
  await page.getByRole("textbox", { name: "Tags", exact: true }).fill("spanish, grammar");
  await clickNavigation(page, "Skills");
  await expect(page.getByRole("heading", { name: "Skills", exact: true, level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/skills$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/skills\/new\/one$/);
  await expect(page.locator("main")).not.toHaveAttribute("data-route-pending", "true");
  await expect(text).toHaveValue("Practice choosing ser or estar from context.");
  await page.reload();
  await expect(text).toHaveValue("Practice choosing ser or estar from context.");
  await page.locator("form.createSkillMaterialForm:visible").getByText("More options", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Collection", exact: true })).toHaveValue("Spanish grammar");
  await expect(page.getByRole("textbox", { name: "Source name", exact: true })).toHaveValue("Chapter 4");
  await expect(page.getByRole("textbox", { name: "Focus", exact: true })).toHaveValue("Use short sentences.");
  await expect(page.getByRole("textbox", { name: "Tags", exact: true })).toHaveValue("spanish, grammar");
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`creation-draft-${width}.png`), fullPage: true });
  }
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(text).toHaveValue("");
  await page.reload();
  await expect(text).toHaveValue("");
});

test("interrupted file selections are named and must be reselected or explicitly omitted", async ({ page }) => {
  await page.goto("/skills/new/one");
  const text = page.getByRole("textbox", { name: "Add learning material", exact: true });
  await expect(text).toBeEnabled();
  await text.fill("Use the attached worksheet to practice verb forms.");
  const buffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  await page.locator('input[type="file"]').setInputFiles(["worksheet.png", "notes.png"].map((name) => ({ name, mimeType: "image/png", buffer })));
  await expect(page.getByText(/Files stay on this page/)).toBeVisible();
  await page.reload();
  await expect(text).toHaveValue("Use the attached worksheet to practice verb forms.");
  await expect(page.getByText(/Choose these files again.*worksheet.png/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create skill", exact: true })).toBeDisabled();
  await page.locator('input[type="file"]').setInputFiles({ name: "worksheet.png", mimeType: "image/png", buffer });
  await expect(page.getByText(/Choose these files again.*notes.png/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Create skill", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Continue without missing files", exact: true }).click();
  await expect(page.getByRole("button", { name: "Create skill", exact: true })).toBeEnabled();
  await page.reload();
  await expect(page.getByText(/Choose these files again.*worksheet.png/)).toBeVisible();
  await expect(page.getByText(/Choose these files again.*notes.png/)).toHaveCount(0);
});
