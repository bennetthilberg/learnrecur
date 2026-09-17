import { randomUUID } from "node:crypto";
import { getTestPostgres } from "../support/postgres";
import { expect, test } from "../fixtures/authenticated";

for (const width of [390, 1280]) {
  test(`page errors retain navigation, focus and draft recovery at ${width}px`, async ({ page, clerkTestUser }, testInfo) => {
    const sql = getTestPostgres(process.env.DATABASE_URL!);
    const collectionId = randomUUID();
    const title = `Error recovery ${width}`;
    await sql.query('INSERT INTO collections (id,"userId",name,"updatedAt") VALUES ($1,$2,$3,now())', [collectionId, clerkTestUser.id, title]);
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/collections");
      const draft = page.getByRole("region", { name: "Add a collection", exact: true }).getByRole("textbox", { name: "Name", exact: true });
      await expect(draft).toBeEnabled();
      await draft.fill("Unfinished collection name");
      // Fail before sending the action to the server: this exercises the actual
      // route boundary without changing the fixture's collection status.
      await page.route("**/collections", route => route.request().method() === "POST" ? route.abort() : route.continue());
      const failAction = async () => {
        await page.getByLabel(`Archive collection ${title}`, { exact: true }).click();
        await page.getByRole("button", { name: "Archive collection", exact: true }).click();
      };
      await failAction();
      const error = page.getByRole("heading", { name: "This page couldn’t load", exact: true });
      await expect(error).toBeFocused();
      const actions = page.locator(".pageErrorActions");
      const retry = page.getByRole("button", { name: "Try again", exact: true });
      const actionBox = await actions.boundingBox();
      const retryBox = await retry.boundingBox();
      expect(actionBox).not.toBeNull();
      expect(retryBox).not.toBeNull();
      expect(Math.abs(actionBox!.x + actionBox!.width - retryBox!.x - retryBox!.width)).toBeLessThan(2);
      await expect(page.locator(".practiceNav")).toBeAttached();
      await page.locator(".practiceFrame").screenshot({ path: testInfo.outputPath(`route-error-${width}.png`) });
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await expect(draft).toHaveValue("Unfinished collection name");
      await expect(error).toHaveCount(0);
      await failAction();
      await expect(error).toBeFocused();
      await page.getByRole("link", { name: "Go to dashboard", exact: true }).click();
      await expect(page).toHaveURL(/\/dashboard$/);
      expect((await sql.query('SELECT status FROM collections WHERE id=$1 AND "userId"=$2', [collectionId, clerkTestUser.id]))[0].status).toBe("ACTIVE");
    } finally {
      await sql.query('DELETE FROM collections WHERE id=$1 AND "userId"=$2', [collectionId, clerkTestUser.id]);
    }
  });
}
