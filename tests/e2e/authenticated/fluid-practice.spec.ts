import { neon } from "@neondatabase/serverless";
import { expect, test } from "../fixtures/learner-lifecycle";

test("replaces a buffered question when its skill becomes unavailable", async ({ page, learnerFixture }) => {
  const sql = neon(process.env.DATABASE_URL!);
  await page.goto("/practice");
  const frame = page.getByRole("region", { name: "Practice exercise", exact: true });
  await expect.poll(async () => Number(await frame.getAttribute("data-buffered-count"))).toBeGreaterThanOrEqual(2);
  if (await page.locator(".choiceCard").count()) await page.locator(".choiceCard").first().click();
  else await page.getByLabel("Your answer", { exact: true }).fill("0");
  await page.getByRole("button", { name: "Check", exact: true }).click();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/practice**", async (route) => {
    if (route.request().method() === "POST") await held;
    await route.continue();
  });
  let bufferedPrompt = "";
  let retiredSkillId = "";
  try {
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByText("Saving…", { exact: true })).toBeVisible();
    bufferedPrompt = await page.locator(".practicePromptPanel").innerText();
    const scenario = Object.values(learnerFixture.scenarios).find((item) => bufferedPrompt.includes(item.exercise.prompt.slice(0, 25)));
    expect(scenario).toBeTruthy();
    retiredSkillId = scenario!.skillId;
    await sql.query('UPDATE exercises SET "retiredAt" = NOW() WHERE "skillId" = $1 AND "userId" = $2', [retiredSkillId, learnerFixture.userId]);
  } finally { release(); }
  await expect(page.getByText("Saving…", { exact: true })).toHaveCount(0);
  await expect(page.locator(".practicePromptPanel")).not.toHaveText(bufferedPrompt);
  const [row] = await sql.query('SELECT count(*)::int AS count, count(*) FILTER (WHERE "skillId" = $2)::int AS retired FROM exercise_attempts WHERE "userId" = $1', [learnerFixture.userId, retiredSkillId]);
  expect(row.count).toBe(1);
  expect(row.retired).toBe(0);
});

for (const custom of [false, true]) {
  test(`advances before save completes in ${custom ? "custom" : "normal"} practice`, async ({ page, learnerFixture }, testInfo) => {
    await page.setViewportSize({ width: custom ? 390 : 1280, height: 900 });
    expect(learnerFixture.userId).toBeTruthy();
    if (custom) {
      await page.goto("/practice/custom");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
    } else await page.goto("/practice");
    const frame = page.getByRole("region", { name: "Practice exercise", exact: true });
    await expect(frame).toHaveAttribute("data-next-ready", "true");
    await expect.poll(async () => Number(await frame.getAttribute("data-buffered-count"))).toBeGreaterThanOrEqual(2);
    const before = await page.locator(".practicePromptPanel").innerText();
    if (await page.locator(".choiceCard").count()) await page.locator(".choiceCard").first().click();
    else await page.getByLabel("Your answer", { exact: true }).fill("0");
    await page.getByRole("button", { name: "Check", exact: true }).click();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/practice**", async (route) => {
      if (route.request().method() === "POST") await held;
      await route.continue();
    });
    try {
      await page.getByRole("button", { name: custom ? "Save practice" : "Continue", exact: true }).click();
      await expect(page.locator(".practicePromptPanel")).not.toHaveText(before, { timeout: 500 });
      await expect(page.getByText("Saving…", { exact: true })).toBeVisible();
      const metadata = await page.locator(".practiceMetaRow > div").boundingBox();
      const saving = await page.getByText("Saving…", { exact: true }).boundingBox();
      expect(Math.abs(metadata!.y - saving!.y)).toBeLessThanOrEqual(2);
      await page.screenshot({ path: testInfo.outputPath("saving-next-exercise.png") });
      if (await page.locator(".choiceCard").count()) await page.locator(".choiceCard").first().click();
      else await page.getByLabel("Your answer", { exact: true }).fill("0");
      await page.getByRole("button", { name: "Check", exact: true }).click();
      await expect(page.getByRole("button", { name: custom ? "Save practice" : "Continue", exact: true })).toBeDisabled();
    } finally { release(); }
    await expect(page.getByText("Saving…", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: custom ? "Save practice" : "Continue", exact: true })).toBeEnabled();
    // The third question must already be buffered too, without another fetch.
    const secondPrompt = await page.locator(".practicePromptPanel").innerText();
    let releaseSecond!: () => void;
    const secondHeld = new Promise<void>((resolve) => { releaseSecond = resolve; });
    await page.route("**/practice**", async (route) => {
      if (route.request().method() === "POST") await secondHeld;
      await route.continue();
    });
    try {
      await page.getByRole("button", { name: custom ? "Save practice" : "Continue", exact: true }).click();
      await expect(page.locator(".practicePromptPanel")).not.toHaveText(secondPrompt, { timeout: 500 });
    } finally { releaseSecond(); }
    await expect(page.getByText("Saving…", { exact: true })).toHaveCount(0);
  });
}

for (const custom of [false, true]) {
  test(`retries a lost save response without duplicating ${custom ? "custom" : "normal"} reviews`, async ({ page, learnerFixture }) => {
    const sql = neon(process.env.DATABASE_URL!);
    if (custom) {
      await page.goto("/practice/custom");
      await page.getByRole("button", { name: "Start session", exact: true }).click();
    } else await page.goto("/practice");
    await expect(page.getByRole("region", { name: "Practice exercise", exact: true })).toHaveAttribute("data-next-ready", "true");
    const before = await page.locator(".practicePromptPanel").innerText();
    if (await page.locator(".choiceCard").count()) await page.locator(".choiceCard").first().click();
    else await page.getByLabel("Your answer", { exact: true }).fill("0");
    await page.getByRole("button", { name: "Check", exact: true }).click();
    await page.route("**/practice**", async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      await route.fetch(); // The server commits, but the acknowledgement is lost.
      await route.abort();
    }, { times: 1 });
    const save = page.getByRole("button", { name: custom ? "Save practice" : "Continue", exact: true });
    await save.click();
    await expect(page.getByText(/Your checked answer is restored/)).toBeVisible();
    await expect(page.locator(".practicePromptPanel")).toHaveText(before);
    await save.click();
    await expect(page.getByText("Saving…", { exact: true })).toHaveCount(0);
    await expect(page.locator(".practicePromptPanel")).not.toHaveText(before);
    await expect.poll(async () => {
      const [row] = await sql.query('SELECT count(*)::int AS count FROM exercise_attempts WHERE "userId" = $1', [learnerFixture.userId]);
      return row.count;
    }).toBe(1);
  });
}
