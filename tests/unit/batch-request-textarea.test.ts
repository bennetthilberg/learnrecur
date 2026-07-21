import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const formStatus = vi.hoisted(() => ({ pending: false }));

vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  useFormStatus: () => ({ pending: formStatus.pending }),
}));

import { BatchRequestTextarea } from "@/app/skills/batches/batch-request-textarea";

describe("BatchRequestTextarea", () => {
  it("disables the request while its form is pending", () => {
    formStatus.pending = true;

    const markup = renderToStaticMarkup(
      createElement(BatchRequestTextarea, {
        defaultValue: "Make five skills from chapter ten.",
        name: "instruction",
      }),
    );

    expect(markup).toContain("aria-busy=\"true\"");
    expect(markup).toContain("disabled");
    expect(markup).toContain("Make five skills from chapter ten.");
  });

  it("keeps the request editable before submission", () => {
    formStatus.pending = false;

    const markup = renderToStaticMarkup(
      createElement(BatchRequestTextarea, {
        name: "instruction",
      }),
    );

    expect(markup).toContain("aria-busy=\"false\"");
    expect(markup).not.toContain("disabled");
  });
});
