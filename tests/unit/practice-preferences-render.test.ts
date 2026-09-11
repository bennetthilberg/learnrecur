import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../../src/app/settings/practice-preference-actions", () => ({
  savePracticePreferencesAction: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

it.each([["UTC", "America/Chicago"], ["America/Chicago"]])(
  "renders settings when browser timezone options are %j",
  async (...timezones) => {
    vi.spyOn(Intl, "supportedValuesOf").mockReturnValue(timezones);
    const { PracticePreferencesForm } = await import(
      "../../src/components/app/practice-preferences-form"
    );
    expect(() =>
      renderToStaticMarkup(
        createElement(
          MantineProvider,
          null,
          createElement(PracticePreferencesForm, {
            target: { scope: "user" },
            preference: "BALANCED",
            practiceTimezone: "UTC",
          }),
        ),
      ),
    ).not.toThrow();
  },
);
