import { clickNavigation } from "../support/navigation";
import { expect, test } from "../fixtures/authenticated";

test("warns before leaving an in-flight creation and keeps the original text", async ({ page }, testInfo) => {
  await page.goto("/skills/new/one");
  const input = page.getByRole("textbox", { name: "Add learning material", exact: true });
  await expect(input).toBeEnabled();
  const original = "Practice deciding between ser and estar in short sentences.";
  await input.fill(original);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/skills/new/one", async route => {
    if (route.request().method() !== "POST") return route.continue();
    await held;
    await route.abort();
  });
  try {
    await page.getByRole("button", { name: "Create skill", exact: true }).click();
    await expect(page.getByText(/Keep this page open until your draft is ready/)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({ path: testInfo.outputPath("creating-390.png") });
    await page.setViewportSize({ width: 1280, height: 900 });
    const cancelNavigation = page.waitForEvent("dialog");
    const navigation = clickNavigation(page, "Dashboard");
    const dialog = await cancelNavigation;
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message()).toContain("Check Skills before starting again");
    await dialog.dismiss();
    await navigation;
    await expect(page).toHaveURL(/\/skills\/new\/one$/);
    const cancelRefresh = page.waitForEvent("dialog");
    const refresh = page.reload({ timeout: 3000 }).catch(() => undefined);
    const unload = await cancelRefresh;
    expect(unload.type()).toBe("beforeunload");
    await unload.dismiss();
    await refresh;
    await expect(page.getByText(/Keep this page open until your draft is ready/)).toBeVisible();
  } finally { release(); }
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue(original);
  await expect(page.getByText(/The connection was interrupted. Your text is kept/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("creation-recovered-1280.png") });
  await page.reload();
  await expect(input).toHaveValue(original);
});
