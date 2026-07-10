import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  useFormStatus: () => ({
    action: null,
    data: null,
    method: null,
    pending: true,
  }),
}));

import { MaterialRetryButton } from "@/app/skills/materials/material-retry-button";

describe("MaterialRetryButton", () => {
  it("keeps a visible spinner and pending label in the button while retrying", () => {
    const markup = renderToStaticMarkup(
      createElement(MaterialRetryButton, null, "Retry processing"),
    );

    expect(markup).toContain("materialRetryButton");
    expect(markup).toContain("buttonSpinner");
    expect(markup).toContain("Retrying processing");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("disabled");
  });
});
