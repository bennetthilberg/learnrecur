import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const formStatus = vi.hoisted(() => ({ pending: false }));

vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  useFormStatus: () => ({ pending: formStatus.pending }),
}));

import { BatchSubmitButton } from "@/app/skills/batches/batch-submit-button";

describe("BatchSubmitButton", () => {
  it("keeps the visible action label and adds a spinner while pending", () => {
    formStatus.pending = true;

    const markup = renderToStaticMarkup(
      createElement(BatchSubmitButton, null, "Review scope"),
    );

    expect(markup).toContain("Review scope");
    expect(markup).not.toContain("Resolving the scope");
    expect(markup).toContain("buttonSpinner");
    expect(markup).toContain("aria-busy=\"true\"");
    expect(markup).toContain("disabled");
  });
});
