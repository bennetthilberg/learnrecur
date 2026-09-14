import { createClerkClient } from "@clerk/backend";
import { neon } from "@neondatabase/serverless";
import { expect, test } from "../fixtures/learner-lifecycle";

for (const custom of [false, true]) {
  test(`restores a checked ${custom ? "custom" : "normal"} answer after the sign-in session ends`, async ({ page, clerkTestUser, learnerFixture }, testInfo) => {
    test.setTimeout(120_000);
    const sql = neon(process.env.DATABASE_URL!);
    await page.goto(custom ? "/practice/custom" : "/practice");
    if (custom) {
      await page.getByRole("spinbutton", { name: /^Exercises/ }).fill("3");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
    }
    const frame = page.getByRole("region", { name: "Practice exercise", exact: true });
    await expect(frame).toHaveAttribute("data-next-ready", "true", { timeout: 20_000 });
    const returnUrl = page.url();
    const prompt = page.locator(".practicePromptPanel");
    const original = await prompt.textContent();
    if (await page.locator(".choiceCard").count()) await page.locator(".choiceCard").first().click();
    else await page.getByLabel("Your answer", { exact: true }).fill("0");
    await page.getByRole("button", { name: "Check", exact: true }).click();
    const save = page.getByRole("button", { name: custom ? "Save practice" : "Continue", exact: true });
    await expect(save).toBeEnabled();

    // Revoke only this isolated test user's sessions. Remove the browser's cached
    // short-lived JWT too, so the next request sees an ended session immediately.
    const backend = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
    const sessions = await backend.sessions.getSessionList({ userId: clerkTestUser.id });
    for (const session of sessions.data) if (session.status === "active") await backend.sessions.revokeSession(session.id);
    await page.context().clearCookies();
    await save.click();
    const signIn = page.getByRole("link", { name: "Sign in to continue", exact: true });
    await expect(signIn).toBeVisible({ timeout: 20_000 });
    await expect(signIn).toBeFocused();
    await expect(save).toBeDisabled();
    await expect(page.locator(".learnrecurNotification")).toHaveCount(0);
    await page.setViewportSize({ width: custom ? 390 : 1280, height: 900 });
    await frame.screenshot({ path: testInfo.outputPath("sign-in-recovery.png") });
    await signIn.click();
    await expect(page).toHaveURL(/sign-in/);
    expect(new URL(page.url()).searchParams.get("redirect_url")).toBe(new URL(returnUrl).pathname + new URL(returnUrl).search);
    expect((await sql.query('SELECT count(*)::int AS count FROM exercise_attempts WHERE "userId"=$1', [learnerFixture.userId]))[0].count).toBe(0);

    await page.getByRole("textbox", { name: /Email address/i }).fill(clerkTestUser.email);
    const codeReady = page.waitForResponse(response => response.url().includes("/prepare_first_factor") && response.request().method() === "POST" && response.ok());
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await codeReady;
    await page.locator('input[autocomplete="one-time-code"]').fill("424242");
    await expect(page).toHaveURL(returnUrl, { timeout: 20_000 });
    await expect(prompt).toHaveText(original ?? "");
    await expect(save).toBeEnabled();
    await expect(page.getByText("Your unfinished answer is here.", { exact: true })).toBeVisible();
    await save.click();
    await expect(prompt).not.toHaveText(original ?? "", { timeout: 20_000 });
    await expect.poll(async () => (await sql.query('SELECT count(*)::int AS count FROM exercise_attempts WHERE "userId"=$1', [learnerFixture.userId]))[0].count).toBe(1);
  });
}
