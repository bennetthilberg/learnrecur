import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PrimaryRouteLoadingContent,
  primaryRouteLoadingByKey,
} from "../../src/app/skills/primary-route-loading-content";

function render(kind: "settings" | "practice") {
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(PrimaryRouteLoadingContent, {
        config: primaryRouteLoadingByKey[kind],
      }),
    ),
  );
}

describe("loading layout continuity", () => {
  it("keeps Settings visible and loads practice preferences before email reminders", () => {
    const markup = render("settings");
    expect(markup).toContain(">Settings</h1>");
    expect(markup).toContain('aria-label="Practice preferences loading"');
    expect(
      markup.indexOf('aria-label="Practice preferences loading"'),
    ).toBeLessThan(markup.indexOf('aria-label="Email reminders loading"'));
  });
  it("reserves the practice toolbar without guessing an answer format", () => {
    const markup = render("practice");
    expect(markup).toContain("practiceToolbar");
    expect(markup).not.toContain('class="choiceGrid"');
    expect(markup).toContain("Loading practice");
  });
});
