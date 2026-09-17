import { clickNavigation } from "../support/navigation";
import { randomUUID } from "node:crypto";
import { getTestPostgres } from "../support/postgres";
import { expect, test } from "../fixtures/authenticated";

test("batch requests restore their text and retry identity without submitting generation", async ({ page, clerkTestUser }, testInfo) => {
  test.setTimeout(90_000);
  const sql = getTestPostgres(process.env.DATABASE_URL!);
  const materialId = `request-material-${randomUUID()}`;
  const revisionId = `request-revision-${randomUUID()}`;
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  try {
    await sql.query('INSERT INTO study_materials (id,"userId",title,kind,"updatedAt") VALUES ($1,$2,\'Spanish reference\',\'PDF\',NOW())', [materialId, clerkTestUser.id]);
    await sql.query('INSERT INTO material_revisions (id,"userId","materialId","revisionNumber",status,"updatedAt") VALUES ($1,$2,$3,1,\'READY\',NOW())', [revisionId, clerkTestUser.id, materialId]);
    await sql.query('UPDATE study_materials SET "activeRevisionId"=$1 WHERE id=$2', [revisionId, materialId]);
    await page.goto(`/skills/materials/${materialId}/create`);
    const request = page.getByRole("textbox", { name: "Skill request", exact: true });
    await request.fill("Make three skills from the examples in chapter four.");
    const identity = await page.locator('input[name="idempotencyKey"]').inputValue();
    await page.reload();
    await expect(request).toHaveValue("Make three skills from the examples in chapter four.");
    await expect(page.locator('input[name="idempotencyKey"]')).toHaveValue(identity);
    await clickNavigation(page, "Skills");
    await expect(page).toHaveURL(/\/skills$/);
    await page.goBack();
    await expect(request).toHaveValue("Make three skills from the examples in chapter four.");
    await expect(page.locator('input[name="idempotencyKey"]')).toHaveValue(identity);
    await request.fill("Make two skills from chapter five.");
    await expect(page.locator('input[name="idempotencyKey"]')).not.toHaveValue(identity);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`batch-request-draft-${width}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    await page.reload();
    await expect(request).toHaveValue("");
    const batches = await sql.query('SELECT id FROM skill_draft_batches WHERE "materialRevisionId"=$1', [revisionId]);
    expect(batches).toHaveLength(0);
  } finally {
    await sql.query('DELETE FROM study_materials WHERE id=$1 AND "userId"=$2', [materialId, clerkTestUser.id]);
  }
});
