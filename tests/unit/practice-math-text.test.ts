import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MathText } from "@/app/practice/math-text";

describe("MathText", () => {
  it("renders underscore runs as a single visual blank when requested", () => {
    const html = renderToStaticMarkup(
      createElement(MathText, {
        formatBlanks: true,
        text: "Hoy nosotros _ _ _ cansados.",
      }),
    );

    expect(html).toContain("mathTextBlank");
    expect(html).toContain("Hoy nosotros ");
    expect(html).toContain(" cansados.");
    expect(html).not.toContain("_ _ _");
  });

  it("supports an explicit blank marker in prompt text", () => {
    const html = renderToStaticMarkup(
      createElement(MathText, {
        formatBlanks: true,
        text: "Ella {{blank}} profesora.",
      }),
    );

    expect(html).toContain("mathTextBlank");
    expect(html).not.toContain("{{blank}}");
  });

  it("preserves underscores when blank formatting is not enabled", () => {
    const html = renderToStaticMarkup(
      createElement(MathText, {
        text: "El libro ___ en la mesa.",
      }),
    );

    expect(html).toContain("___");
    expect(html).not.toContain("mathTextBlank");
  });
});
