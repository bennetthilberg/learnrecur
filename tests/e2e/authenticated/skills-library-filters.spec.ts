import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { expect, test } from "../fixtures/authenticated";

test("a large skills library supports combined filters and restores them after opening a skill", async ({ page, clerkTestUser }, testInfo) => {
  test.setTimeout(90_000);
  const sql = neon(process.env.DATABASE_URL!);
  const prefix = `library-${randomUUID()}`;
  const collectionId = `${prefix}-collection`;
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  try {
    await sql.query('INSERT INTO collections (id,"userId",name,"updatedAt") VALUES ($1,$2,\'Spanish\',NOW())', [collectionId, clerkTestUser.id]);
    await sql.query(`INSERT INTO skills (id,"userId","collectionId",title,status,tags,"updatedAt")
      SELECT $1 || '-' || n, $2, CASE WHEN n % 2 = 0 THEN $3 ELSE NULL END,
      'Spanish sentence ' || lpad(n::text,3,'0') || ' with a longer title for responsive reading',
      (CASE WHEN n <= 60 THEN 'ACTIVE' WHEN n <= 120 THEN 'PAUSED' ELSE 'ARCHIVED' END)::"SkillStatus",
      ARRAY['grammar'],NOW() FROM generate_series(1,180) n`, [prefix, clerkTestUser.id, collectionId]);
    await page.goto("/skills");
    const library = page.getByRole("region", { name: "Skills library", exact: true });
    await expect(library.getByRole("status")).toHaveText("60 skills · Showing 50");
    await expect(library.locator("article")).toHaveCount(50);
    await library.getByRole("button", { name: "Load more skills" }).click();
    await expect(library.locator("article")).toHaveCount(60);
    const choose = async (label: string, option: string) => {
      await library.getByRole("combobox", { name: label, exact: true }).click();
      await page.getByRole("option", { name: option, exact: true }).click();
    };
    await choose("Status", "Paused");
    await choose("Collection", "Spanish");
    await expect(library.getByRole("status")).toHaveText("30 skills");
    const search = library.getByRole("textbox", { name: "Search skills", exact: true });
    await search.fill("sentence 062");
    await expect(library.locator("article")).toHaveCount(1);
    await library.getByRole("link", { name: /^Open Spanish sentence 062/ }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("sentence 062");
    await page.goBack();
    await expect(search).toHaveValue("sentence 062");
    await expect(library.locator("article")).toHaveCount(1);
    await page.reload();
    await expect(search).toHaveValue("sentence 062");
    await search.fill("not present");
    await expect(library.getByRole("heading", { name: "No matching skills" })).toBeVisible();
    await library.getByRole("button", { name: "Clear search and collection" }).click();
    await choose("Status", "Archived");
    await choose("Collection", "Uncollected");
    await expect(library.getByRole("status")).toHaveText("30 skills");
    for (const width of [390, 820, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`library-${width}.png`) });
    }
  } finally {
    await sql.query('DELETE FROM skills WHERE "userId"=$1 AND id LIKE $2', [clerkTestUser.id, `${prefix}-%`]);
    await sql.query('DELETE FROM collections WHERE "userId"=$1 AND id=$2', [clerkTestUser.id, collectionId]);
  }
});
