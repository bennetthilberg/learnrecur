import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import PrivacyPage from "@/app/privacy/page";
import TermsPage from "@/app/terms/page";
import { getSupportEmail } from "@/lib/support";

const originalSupportEmail = process.env.SUPPORT_EMAIL;

afterEach(() => {
  if (originalSupportEmail === undefined) {
    delete process.env.SUPPORT_EMAIL;
  } else {
    process.env.SUPPORT_EMAIL = originalSupportEmail;
  }
});

describe("public alpha policy copy", () => {
  it("publishes current privacy and deletion behavior without draft placeholders", () => {
    process.env.SUPPORT_EMAIL = "help@example.com";
    const markup = renderToStaticMarkup(createElement(PrivacyPage));

    expect(markup).toContain("Closed alpha");
    expect(markup).toContain("background deletion workflow");
    expect(markup).toContain("mailto:help@example.com");
    expect(markup).toContain("/terms");
    expect(markup).not.toMatch(/legal advice|legal review|policy draft|handled manually/i);
  });

  it("publishes current participation terms and links privacy and support", () => {
    process.env.SUPPORT_EMAIL = "help@example.com";
    const markup = renderToStaticMarkup(createElement(TermsPage));

    expect(markup).toContain("Closed alpha");
    expect(markup).toContain("mailto:help@example.com");
    expect(markup).toContain("/privacy");
    expect(markup).not.toMatch(/legal advice|legal review|participation draft|handled manually/i);
  });

  it("does not invent a support address when configuration is absent or invalid", () => {
    delete process.env.SUPPORT_EMAIL;
    expect(getSupportEmail()).toBeNull();
    expect(getSupportEmail({ SUPPORT_EMAIL: "invalid" })).toBeNull();
    expect(getSupportEmail({ SUPPORT_EMAIL: " Help@Example.com " })).toBe("help@example.com");
  });
});
