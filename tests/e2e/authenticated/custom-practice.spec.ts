import { expect, test } from "../fixtures/learner-lifecycle";
import { readE2EPracticeState } from "../support/database";

test("opens a bounded practice-only session from normal practice and keeps it out of FSRS", async ({
  learnerFixture,
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const scenario = learnerFixture.scenarios.choice;
  const before = await readE2EPracticeState({
    exerciseId: scenario.exercise.id,
    skillId: scenario.skillId,
    userId: scenario.userId,
  });

  await page.goto(`/practice?collectionId=${encodeURIComponent(scenario.collectionId)}`);
  await expect(page.getByRole("link", { name: "Custom session", exact: true })).toHaveAttribute(
    "href",
    "/practice/custom",
  );
  await page.getByRole("link", { name: "Custom session", exact: true }).click();
  await expect(page).toHaveURL(/\/practice\/custom$/);
  await expect(page.getByRole("heading", { name: "Set up a custom session", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: /Practice only/i })).toBeChecked();
  await expect(page.getByRole("link", { name: "Needs attention", exact: true })).toHaveAttribute(
    "href",
    "/practice/attention",
  );

  await page.goto(`/practice/custom?skillId=${encodeURIComponent(scenario.skillId)}`);
  await expect(
    page.getByRole("checkbox", { name: new RegExp(scenario.skillTitle, "i") }),
  ).toBeChecked();
  await page.getByRole("checkbox", { name: /Mixed review/i }).check();
  const desktopSetupLayout = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>(".customPracticeHeader");
    const rect = header?.getBoundingClientRect();
    return {
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      headerLeft: rect?.left ?? null,
      headerRight: rect?.right ?? null,
    };
  });
  expect(desktopSetupLayout.documentScrollWidth).toBeLessThanOrEqual(desktopSetupLayout.documentClientWidth);
  expect(desktopSetupLayout.headerLeft).toBeGreaterThanOrEqual(14);
  expect(desktopSetupLayout.headerRight).toBeLessThanOrEqual(desktopSetupLayout.documentClientWidth - 14);
  await page.screenshot({
    path: testInfo.outputPath("custom-setup-desktop.png"),
    fullPage: true,
  });
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const mobileSetupLayout = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(".customPracticeHeader");
      const rect = header?.getBoundingClientRect();
      return {
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        headerLeft: rect?.left ?? null,
        headerRight: rect?.right ?? null,
      };
    });
    expect(mobileSetupLayout.documentScrollWidth).toBeLessThanOrEqual(mobileSetupLayout.documentClientWidth);
    expect(mobileSetupLayout.headerLeft).toBeGreaterThanOrEqual(14);
    expect(mobileSetupLayout.headerRight).toBeLessThanOrEqual(mobileSetupLayout.documentClientWidth - 14);
    if (width === 390) {
      await page.screenshot({
        path: testInfo.outputPath("custom-setup-mobile.png"),
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.getByRole("combobox", { name: "Collection", exact: true }).selectOption(scenario.collectionId);
  await page.getByRole("checkbox", { name: new RegExp(scenario.skillTitle, "i") }).check();
  await page.getByRole("spinbutton", { name: /^Exercises\b/ }).fill("1");
  await page.getByRole("button", { name: "Start session", exact: true }).click();
  await expect(page).toHaveURL(/\/practice\?sessionId=/);
  await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
  await expect(page.getByLabel("Custom practice session")).toContainText("Practice only");
  await page.screenshot({
    path: testInfo.outputPath("custom-session-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("custom-session-mobile.png"),
    fullPage: true,
  });
  const mobileLayout = await page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>(".practiceFrame");
    const rect = frame?.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      frameLeft: rect?.left ?? null,
      frameRight: rect?.right ?? null,
    };
  });
  console.info(`[custom mobile layout] ${JSON.stringify(mobileLayout)}`);
  expect(mobileLayout.documentScrollWidth).toBeLessThanOrEqual(mobileLayout.documentClientWidth);
  expect(mobileLayout.frameLeft).toBeGreaterThanOrEqual(14);
  expect(mobileLayout.frameRight).toBeLessThanOrEqual(mobileLayout.documentClientWidth - 14);
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.locator(".choiceCard").first().click();
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByRole("heading", { name: scenario.skillTitle, exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Correct");
  await page.getByRole("button", { name: "Save practice", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Session complete.", exact: true })).toBeVisible();

  const after = await readE2EPracticeState({
    exerciseId: scenario.exercise.id,
    skillId: scenario.skillId,
    userId: scenario.userId,
  });
  expect(after.attemptCount).toBe(1);
  expect(after.reviewLogCount).toBe(0);
  expect(after.repetitions).toBe(before.repetitions);
  expect(after.dueAt).toBe(before.dueAt);
});
