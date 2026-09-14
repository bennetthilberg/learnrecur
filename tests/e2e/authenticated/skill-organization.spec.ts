import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { expect, test } from "../fixtures/learner-lifecycle";

test("rename and move preserve unfinished edits and update the library", async ({ page, learnerFixture }, testInfo) => {
  test.setTimeout(90_000);
  const sql = neon(process.env.DATABASE_URL!);
  const skill = learnerFixture.scenarios.choice;
  await page.goto(`/skills/${skill.skillId}`);
  const [before] = await sql.query('SELECT "userId","dueAt",stability,difficulty,repetitions FROM skills WHERE id=$1', [skill.skillId]);
  const collectionId = `organization-${randomUUID()}`;
  try {
    await sql.query('INSERT INTO collections (id,"userId",name,"updatedAt") VALUES ($1,$2,\'Spanish course\',NOW())', [collectionId, before.userId]);
    await page.reload();
    await page.getByRole("button", { name: "Rename skill", exact: true }).click();
    const rename = page.getByRole("dialog", { name: "Rename skill", exact: true });
    await rename.getByRole("textbox", { name: "Skill name" }).fill("Spanish verbs in everyday sentences");
    await rename.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "Rename skill", exact: true }).click();
    await expect(rename.getByRole("textbox", { name: "Skill name" })).toHaveValue("Spanish verbs in everyday sentences");
    await page.route("**/*", (route) => route.request().method() === "POST" ? route.abort() : route.continue());
    await rename.getByRole("button", { name: "Save name", exact: true }).click();
    await expect(rename.getByRole("alert")).toContainText("Could not save");
    await page.unroute("**/*");
    await rename.getByRole("button", { name: "Save name", exact: true }).click();
    await expect(rename).toBeHidden({ timeout: 15_000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Spanish verbs in everyday sentences");
    await page.getByRole("button", { name: "Move to collection", exact: true }).click();
    await expect(page.getByText("Skill renamed.", { exact: true })).toHaveCount(0);
    const move = page.getByRole("dialog", { name: "Move to collection", exact: true });
    await move.getByRole("combobox", { name: "Collection", exact: true }).click();
    await page.getByRole("option", { name: "Spanish course", exact: true }).click();
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`organization-${width}.png`) });
    }
    await move.getByRole("button", { name: "Move skill", exact: true }).click();
    await expect(move).toBeHidden({ timeout: 15_000 });
    await expect(page.getByRole("region", { name: "Schedule", exact: true })).toContainText("Spanish course");
    const [after] = await sql.query('SELECT "userId","dueAt",stability,difficulty,repetitions FROM skills WHERE id=$1', [skill.skillId]);
    expect(after).toEqual(before);
    await page.getByRole("button", { name: "Move to collection", exact: true }).click();
    await move.getByRole("button", { name: "Close move dialog" }).click();
    await expect(page.getByRole("button", { name: "Move to collection", exact: true })).toBeFocused();
    await page.goto(`/skills?collection=${collectionId}`);
    await expect(page.getByRole("link", { name: "Open Spanish verbs in everyday sentences", exact: true })).toBeVisible();
  } finally {
    await sql.query('UPDATE skills SET "collectionId"=NULL WHERE id=$1', [skill.skillId]);
    await sql.query('DELETE FROM collections WHERE id=$1', [collectionId]);
  }
});
