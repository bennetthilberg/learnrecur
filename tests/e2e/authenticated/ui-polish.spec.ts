import { expect, test } from "../fixtures/learner-lifecycle";

for (const width of [1280, 390]) {
  test(`skill actions stay in context and controls fit at ${width}px`, async ({
    page,
    learnerFixture,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    const skill = learnerFixture.scenarios.choice;
    await page.goto("/skills");
    const trigger = page.getByRole("button", {
      name: `Open actions for ${skill.skillTitle}`,
    });
    await trigger.click();
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Archive skill?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(skill.skillTitle);
    await expect(page).toHaveURL(/\/skills$/);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Archive skill", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".learnrecurNotification")).toContainText(
      /archived/i,
    );
    await expect(page).toHaveURL(/\/skills$/);

    await trigger.click();
    await page
      .getByRole("menuitem", { name: "Delete permanently", exact: true })
      .click();
    const deletion = page.getByRole("dialog", {
      name: "Delete skill permanently?",
    });
    const deleteButton = deletion.getByRole("button", {
      name: "Delete skill",
      exact: true,
    });
    await expect(deleteButton).toBeDisabled();
    await deletion.getByRole("textbox").fill("incorrect title");
    await expect(deleteButton).toBeDisabled();
    await deletion.getByRole("textbox").fill(skill.skillTitle);
    await expect(deleteButton).toBeEnabled();
    await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(deletion).toBeHidden();
    await trigger.click();
    await page.getByRole("menuitem", { name: "Delete permanently", exact: true }).click();
    await deletion.getByRole("textbox").fill(skill.skillTitle);
    await deleteButton.click();
    await expect(page.locator(".learnrecurNotification").filter({ hasText: "Skill permanently deleted." })).toBeVisible();
    await expect(trigger).toHaveCount(0);

    await page.goto("/settings");
    const preference = page.getByRole("combobox", {
      name: "Practice preference",
      exact: true,
    });
    await expect(preference).toBeEnabled();
    expect((await preference.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.getByText("Advanced practice settings", { exact: true }).click();
    await expect(
      page.getByLabel("Practice day starts at", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);

    await page.goto(
      `/practice?collectionId=${learnerFixture.scenarios.text.collectionId}`,
    );
    await expect(page.getByLabel("Your answer", { exact: true })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Mixed review", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Review", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: learnerFixture.scenarios.text.skillTitle, exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Custom session", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}
