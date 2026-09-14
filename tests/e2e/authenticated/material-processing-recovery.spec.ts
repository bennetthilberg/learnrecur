import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { expect, test } from "../fixtures/authenticated";

test("a background import retains processing and failure state through navigation and refresh", async ({ page, clerkTestUser }, testInfo) => {
  test.setTimeout(60_000);
  const sql = neon(process.env.DATABASE_URL!);
  const materialId = randomUUID();
  const revisionId = randomUUID();
  await sql.query('INSERT INTO study_materials (id,"userId",title,kind,"updatedAt") VALUES ($1,$2,$3,\'PDF\',now())', [materialId, clerkTestUser.id, "Long reference import"]);
  try {
    await sql.query('INSERT INTO material_revisions (id,"userId","materialId","revisionNumber",status,"updatedAt") VALUES ($1,$2,$3,1,\'PROCESSING\',now())', [revisionId, clerkTestUser.id, materialId]);
    await page.goto(`/skills/materials/${materialId}`);
    const processing = page.getByRole("heading", { name: "Building the outline", exact: true });
    await expect(processing).toBeVisible();
    await expect(page.getByText(/You can leave this page; processing continues/)).toBeVisible();
    await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto("/skills/materials");
    await expect(page.getByText("Processing", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator(".materialLibraryPanel").screenshot({ path: testInfo.outputPath("processing-library-1280.png") });
    await page.getByRole("link", { name: "Long reference import", exact: true }).click();
    await expect(processing).toBeVisible();
    await page.reload();
    await expect(processing).toBeVisible();
    await page.setViewportSize({ width: 390, height: 900 });
    await page.locator(".materialProcessingPanel").screenshot({ path: testInfo.outputPath("processing-390.png") });
    // Simulate a persisted worker failure; the browser must pick up the state.
    await page.goto("/skills/materials");
    await expect(page.getByText("Processing", { exact: true })).toBeVisible();
    await sql.query('UPDATE material_revisions SET status=\'FAILED\',"errorMessage"=$2,"updatedAt"=now() WHERE id=$1', [revisionId, "Some pages could not be read. Retry this import."]);
    await expect(page.getByText("Needs attention", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.locator(".materialLibraryPanel").screenshot({ path: testInfo.outputPath("failed-library-390.png") });
    await page.getByRole("link", { name: "Review import", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry import", exact: true })).toBeEnabled();
    expect((await sql.query('SELECT count(*)::int AS count FROM material_revisions WHERE "materialId"=$1', [materialId]))[0].count).toBe(1);
  } finally {
    await page.goto("/dashboard", { waitUntil: "domcontentloaded", timeout: 5000 }).catch(() => undefined);
    await sql.query('DELETE FROM study_materials WHERE id=$1 AND "userId"=$2', [materialId, clerkTestUser.id]);
  }
});
