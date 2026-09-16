import { expect, test } from "../fixtures/authenticated";

test("collection creation and edits survive refresh and clear only after save or discard", async ({ page }, testInfo) => {
  await page.goto("/collections");
  const create = page.locator("form.collectionCreateForm");
  await create.getByRole("textbox", { name: "Name", exact: true }).fill("Spanish notes");
  await create.getByRole("textbox", { name: "Description", exact: true }).fill("Grammar from my textbook.");
  await page.reload();
  await expect(create.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Spanish notes");
  await expect(create.getByRole("textbox", { name: "Description", exact: true })).toHaveValue("Grammar from my textbook.");
  await create.getByRole("button", { name: "Create collection", exact: true }).click();
  await expect(page.getByText("Collection created.", { exact: true })).toBeVisible();
  await expect(create.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("");
  await page.getByLabel("Edit collection Spanish notes", { exact: true }).click();
  const edit = page.locator(".collectionInlineForm").filter({ has: page.getByRole("textbox", { name: "Name", exact: true }) });
  await edit.getByRole("textbox", { name: "Name", exact: true }).fill("Spanish grammar");
  await page.reload();
  await page.getByLabel("Edit collection Spanish notes", { exact: true }).click();
  await expect(edit.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Spanish grammar");
  await page.route("**/collections", (route) => route.request().method() === "POST" ? route.abort() : route.continue());
  await edit.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Could not save the collection. Check your connection and try again.")).toBeVisible();
  await expect(edit.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Spanish grammar");
  await page.unroute("**/collections");
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`collection-draft-${width}.png`), fullPage: true });
  }
  await edit.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(edit.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Spanish notes");
  await edit.getByRole("textbox", { name: "Name", exact: true }).fill("Spanish grammar");
  await edit.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Collection updated.", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByLabel("Edit collection Spanish grammar", { exact: true }).click();
  await expect(edit.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Spanish grammar");
  await expect(edit.getByRole("button", { name: "Discard changes", exact: true })).toHaveCount(0);
});
