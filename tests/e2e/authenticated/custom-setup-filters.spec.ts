import { neon } from "@neondatabase/serverless";
import { expect, test } from "../fixtures/learner-lifecycle";

test("custom setup previews filters and restores unfinished choices", async ({ page, learnerFixture }, testInfo) => {
  test.setTimeout(90_000);
  const sql = neon(process.env.DATABASE_URL!);
  const skill = learnerFixture.scenarios.choice;
  await sql.query('UPDATE skills SET tags=ARRAY[\'spanish\',\'verbs\'], "dueAt"=NOW()+INTERVAL \'1 day\' WHERE id=$1', [skill.skillId]);
  await page.goto(`/practice/custom?skillId=${skill.skillId}`);
  const list = page.getByRole("group", { name: /^Choose skills/ });
  await expect(list.getByRole("status")).toHaveText("1 eligible skill · 1 selected");
  await page.getByRole("radio", { name: /^Scheduled review/ }).check();
  await expect(list.getByRole("status")).toHaveText("0 eligible skills · 1 selected");
  await expect(page.getByRole("button", { name: "Start session", exact: true })).toBeDisabled();
  await expect(list.getByText(/1 selected skill does not match/)).toBeVisible();
  await page.getByRole("radio", { name: /^Practice only/ }).check();
  await page.getByRole("checkbox", { name: "spanish", exact: true }).check();
  await expect(list.getByRole("checkbox")).toHaveCount(1);
  const count = page.getByRole("spinbutton", { name: /^Exercises/ });
  await count.fill("");
  await expect(count).toHaveValue("");
  await count.fill("12");
  await page.reload();
  await expect(count).toHaveValue("12");
  await expect(page.getByRole("checkbox", { name: "spanish", exact: true })).toBeChecked();
  await page.getByRole("checkbox", { name: /^Recently missed/ }).check();
  await expect(list.getByRole("status")).toHaveText("0 eligible skills · 1 selected");
  await page.getByRole("checkbox", { name: /^Recently missed/ }).uncheck();
  await page.getByRole("combobox", { name: "Collection", exact: true }).click();
  const [collection] = await sql.query('SELECT name FROM collections WHERE id=$1', [skill.collectionId]);
  await page.getByRole("option", { name: collection.name, exact: true }).click();
  await expect(list.getByRole("checkbox")).toHaveCount(1);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`custom-setup-${width}.png`), fullPage: true });
  }
  await page.route("**/*", (route) => route.request().method() === "POST" ? route.abort() : route.continue());
  await page.getByRole("button", { name: "Start session", exact: true }).click();
  await expect(page.getByText(/Your choices are kept/)).toBeVisible();
  await page.unroute("**/*");
  await expect(count).toHaveValue("12");
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(count).toHaveValue("10");
});
