import { clickNavigation } from "../support/navigation";
import { expect, test } from "../fixtures/authenticated";

test("material input drafts survive tab changes, refresh and navigation", async ({ page }, testInfo) => {
  await page.goto("/skills/new/multiple");
  const pdf = page.getByRole("tabpanel", { name: "PDF", exact: true });
  const website = page.getByRole("tabpanel", { name: "Website", exact: true });
  await expect(pdf.getByRole("textbox", { name: "Material title" })).toBeEnabled();
  await pdf.getByRole("textbox", { name: "Material title" }).fill("Spanish reference");
  await pdf.locator('input[type="file"]').setInputFiles({ name: "reference.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF") });
  await page.getByRole("tab", { name: "Website", exact: true }).click();
  await website.getByRole("textbox", { name: /URL/ }).fill("https://example.com/reference");
  await page.getByRole("tab", { name: "PDF", exact: true }).click();
  await expect(pdf.getByRole("textbox", { name: "Material title" })).toHaveValue("Spanish reference");
  expect(await pdf.locator('input[type="file"]').evaluate((input: HTMLInputElement) => input.files?.length)).toBe(1);
  await page.reload();
  await expect(pdf.getByRole("textbox", { name: "Material title" })).toHaveValue("Spanish reference");
  await expect(pdf.getByText(/Choose reference.pdf again/)).toBeVisible();
  await expect(pdf.getByRole("button", { name: "Import PDF", exact: true })).toBeDisabled();
  await page.getByRole("tab", { name: "Website", exact: true }).click();
  await expect(website.getByRole("textbox", { name: /URL/ })).toHaveValue("https://example.com/reference");
  await clickNavigation(page, "Skills");
  await expect(page).toHaveURL(/\/skills$/);
  await page.goBack();
  await page.getByRole("tab", { name: "Website", exact: true }).click();
  await expect(website.getByRole("textbox", { name: /URL/ })).toHaveValue("https://example.com/reference");
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`material-draft-${width}.png`), fullPage: true });
  }
  await website.getByRole("button", { name: "Discard changes" }).click();
  await page.reload();
  await page.getByRole("tab", { name: "Website", exact: true }).click();
  await expect(website.getByRole("textbox", { name: /URL/ })).toHaveValue("");
});

test("restored website pages remain selected and a failed import keeps the draft", async ({ page, clerkTestUser }) => {
  await page.goto("/skills/new/multiple");
  await expect(page.getByRole("heading", { name: "Create multiple skills" })).toBeVisible();
  const initial = { url: "", title: "", collectionId: "", selectedUrls: [], discovery: null };
  const value = {
    url: "https://example.com/book", title: "Spanish reference", collectionId: "", selectedUrls: ["https://example.com/book/chapter-2"],
    discovery: { title: "Spanish book", sourceUrl: "https://example.com/book", pages: [
      { title: "Chapter one", url: "https://example.com/book/chapter-1", level: 1 },
      { title: "Chapter two", url: "https://example.com/book/chapter-2", level: 1 },
    ], preferredPdf: null },
  };
  await page.evaluate(({ key, initial, value }) => sessionStorage.setItem(key, JSON.stringify({ baseline: JSON.stringify(initial), value })), { key: `learnrecur:form:v1:${clerkTestUser.id}:material-website`, initial, value });
  await page.reload();
  await page.getByRole("tab", { name: "Website", exact: true }).click();
  const website = page.getByRole("tabpanel", { name: "Website", exact: true });
  await expect(website.getByRole("checkbox", { name: "Chapter two", exact: true })).toBeChecked();
  await expect(website.getByRole("checkbox", { name: "Chapter one", exact: true })).not.toBeChecked();
  await website.getByRole("checkbox", { name: "Chapter one", exact: true }).check();
  await page.reload();
  await page.getByRole("tab", { name: "Website", exact: true }).click();
  await expect(website.getByRole("checkbox", { name: "Chapter one", exact: true })).toBeChecked();
  await page.route("**/skills/new/multiple", (route) => route.request().method() === "POST" ? route.abort() : route.continue());
  await website.getByRole("button", { name: "Import selected pages" }).click();
  await expect(page.getByText("Could not reach the server. Check your connection and try again.")).toBeVisible();
  await expect(website.getByRole("button", { name: "Import selected pages" })).toBeEnabled();
  await page.reload();
  await page.getByRole("tab", { name: "Website", exact: true }).click();
  await expect(website.getByRole("textbox", { name: "Material title" })).toHaveValue("Spanish reference");
  await expect(website.getByRole("checkbox", { name: "Chapter two", exact: true })).toBeChecked();
});
