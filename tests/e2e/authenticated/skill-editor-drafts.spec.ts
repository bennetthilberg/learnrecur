import { clickNavigation } from "../support/navigation";
import { neon } from "@neondatabase/serverless";
import { expect, test } from "../fixtures/learner-lifecycle";

test("skill draft edits survive refresh and leave the saved skill unchanged until submission", async ({ page, learnerFixture }, testInfo) => {
  const skill = learnerFixture.scenarios.choice;
  const sql = neon(process.env.DATABASE_URL!);
  await sql.query('UPDATE skills SET status=\'DRAFT\' WHERE id=$1 AND "userId"=$2', [skill.skillId, skill.userId]);
  await page.goto(`/skills/${skill.skillId}`);
  const editor = page.locator("form.skillDraftForm");
  const title = editor.getByRole("textbox", { name: "Title", exact: true });
  await expect(title).toBeEnabled();
  const originalTitle = await title.inputValue();
  await title.fill("Choosing a verb from the sentence context");
  await editor.getByRole("textbox", { name: "Rules", exact: true }).fill("Read the whole sentence before selecting a verb.");
  await page.reload();
  await expect(title).toHaveValue("Choosing a verb from the sentence context");
  await expect(editor.getByRole("textbox", { name: "Rules", exact: true })).toHaveValue("Read the whole sentence before selecting a verb.");
  const rows = await sql.query('SELECT title FROM skills WHERE id=$1 AND "userId"=$2', [skill.skillId, skill.userId]);
  expect(rows[0].title).toBe(originalTitle);
  await clickNavigation(page, "Skills");
  await expect(page).toHaveURL(/\/skills$/);
  await page.goBack();
  await expect(title).toHaveValue("Choosing a verb from the sentence context");
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`skill-editor-draft-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await editor.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect(title).toHaveValue(originalTitle);
  await page.reload();
  await expect(title).toHaveValue(originalTitle);
  await expect(editor.getByRole("button", { name: "Discard changes", exact: true })).toHaveCount(0);
});

test("batch editor restores dismissed edits and clears them after a confirmed save", async ({ page, learnerFixture }) => {
  test.setTimeout(90_000);
  const skill = learnerFixture.scenarios.choice;
  const sql = neon(process.env.DATABASE_URL!);
  const materialId = `draft-test-material-${skill.skillId}`;
  const revisionId = `draft-test-revision-${skill.skillId}`;
  const batchId = `draft-test-batch-${skill.skillId}`;
  try {
    await sql.query('UPDATE skills SET status=\'DRAFT\' WHERE id=$1 AND "userId"=$2', [skill.skillId, skill.userId]);
    await sql.query('INSERT INTO study_materials (id,"userId",title,kind,"updatedAt") VALUES ($1,$2,\'Editor test material\',\'PDF\',NOW())', [materialId, skill.userId]);
    await sql.query('INSERT INTO material_revisions (id,"userId","materialId","revisionNumber",status,"updatedAt") VALUES ($1,$2,$3,1,\'READY\',NOW())', [revisionId, skill.userId, materialId]);
    await sql.query('INSERT INTO skill_draft_batches (id,"userId","materialRevisionId",instruction,status,"idempotencyKey","requestedCount","readyCount","updatedAt") VALUES ($1,$2,$3,\'Practice grammar\',\'READY\',$1,1,1,NOW())', [batchId, skill.userId, revisionId]);
    await sql.query('INSERT INTO skill_draft_batch_items (id,"userId","batchId","skillId",ordinal,"targetKey","proposedTitle","proposedObjective",locator,status,"updatedAt") VALUES ($1,$2,$3,$4,1,\'grammar\',\'Grammar\',\'Choose a verb\',\'{}\'::jsonb,\'READY\',NOW())', [`item-${batchId}`, skill.userId, batchId, skill.skillId]);
    await page.goto(`/skills/batches/${batchId}`);
    await page.getByRole("button", { name: "Edit draft", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Edit draft", exact: true });
    const title = dialog.getByRole("textbox", { name: "Title", exact: true });
    await title.fill("Grammar from context");
    await dialog.getByRole("button", { name: "Close draft editor", exact: true }).click();
    await page.getByRole("button", { name: "Edit draft", exact: true }).click();
    await expect(title).toHaveValue("Grammar from context");
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    await page.getByRole("button", { name: "Edit draft", exact: true }).click();
    await expect(title).toHaveValue("Grammar from context");
    await expect(dialog.getByRole("button", { name: "Discard changes", exact: true })).toHaveCount(0);
    const saved = await sql.query('SELECT title,status FROM skills WHERE id=$1 AND "userId"=$2', [skill.skillId, skill.userId]);
    expect(saved[0]).toMatchObject({ title: "Grammar from context", status: "DRAFT" });
  } finally {
    await sql.query('DELETE FROM study_materials WHERE id=$1 AND "userId"=$2', [materialId, skill.userId]);
  }
});
