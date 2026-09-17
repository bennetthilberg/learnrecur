import { Checkbox, MantineProvider } from "@mantine/core";
import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

for (const width of [390, 1440]) {
  test(`checkbox cursors match clickable targets at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const mantine = renderToStaticMarkup(
      createElement(MantineProvider, null,
        createElement(Checkbox, {
          id: "studied", label: "I have already studied this skill",
          description: "Allow suitable input practice from the first review.",
        }),
        createElement(Checkbox, { id: "disabled", label: "Disabled checkbox", disabled: true }),
        createElement("fieldset", { disabled: true },
          createElement(Checkbox, { id: "fieldset", label: "Disabled fieldset checkbox" }),
        ),
      ),
    );
    await page.setContent(`${mantine}
      <label class="skillLifecycleConfirm"><input type="checkbox" id="archive">
        <span>Archive this skill and keep its sources, exercises, and history.</span>
      </label>
      <label><input type="checkbox" disabled>Unavailable native checkbox</label>
      <label for="title">Skill title</label><input id="title" type="text">
    `);
    for (const path of ["node_modules/@mantine/core/styles.css", "src/app/globals.css", "src/app/open-water.css"]) {
      await page.addStyleTag({ path });
    }

    for (const id of ["studied", "archive"]) {
      const checkbox = page.locator(`#${id}`);
      const label = page.locator(id === "studied" ? 'label[for="studied"]' : ".skillLifecycleConfirm span");
      await checkbox.hover();
      await expect(checkbox).toHaveCSS("cursor", "pointer");
      await label.hover();
      await expect(label).toHaveCSS("cursor", "pointer");
      await label.click();
      await expect(checkbox).toBeChecked();
      await checkbox.click();
      await expect(checkbox).not.toBeChecked();
    }
    await expect(page.locator(".mantine-Checkbox-description")).not.toHaveCSS("cursor", "pointer");
    await expect(page.locator('label[for="title"]')).not.toHaveCSS("cursor", "pointer");
    for (const id of ["disabled", "fieldset"]) {
      await expect(page.locator(`#${id}`)).toBeDisabled();
      await expect(page.locator(`#${id}`)).not.toHaveCSS("cursor", "pointer");
      await expect(page.locator(`label[for="${id}"]`)).not.toHaveCSS("cursor", "pointer");
    }
    await expect(page.getByText("Unavailable native checkbox")).not.toHaveCSS("cursor", "pointer");
    await page.screenshot({ path: testInfo.outputPath("checkbox-cursors.png") });
  });
}
