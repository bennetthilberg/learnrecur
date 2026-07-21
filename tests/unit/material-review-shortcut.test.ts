import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  detectMaterialReviewShortcut,
  isMaterialReviewShortcutEvent,
  type MaterialReviewShortcutEvent,
} from "@/lib/material-review-shortcut";

const enterEvent: MaterialReviewShortcutEvent = {
  altKey: false,
  ctrlKey: false,
  isComposing: false,
  key: "Enter",
  metaKey: false,
  repeat: false,
  shiftKey: false,
};

describe("detectMaterialReviewShortcut", () => {
  it("offers Command-Enter on desktop macOS", () => {
    expect(
      detectMaterialReviewShortcut({
        maxTouchPoints: 0,
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      }),
    ).toEqual({
      ariaKeyShortcuts: "Meta+Enter",
      keyLabel: "⌘ Enter",
      platform: "mac",
    });

    expect(
      detectMaterialReviewShortcut({
        maxTouchPoints: 0,
        platform: "macOS",
        userAgent: "Mozilla/5.0",
      }),
    ).toMatchObject({ platform: "mac" });
  });

  it("offers Control-Enter on desktop Windows", () => {
    expect(
      detectMaterialReviewShortcut({
        maxTouchPoints: 10,
        platform: "Win32",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      }),
    ).toEqual({
      ariaKeyShortcuts: "Control+Enter",
      keyLabel: "Ctrl Enter",
      platform: "windows",
    });
  });

  it("prefers User-Agent Client Hints when they are available", () => {
    expect(
      detectMaterialReviewShortcut({
        maxTouchPoints: 0,
        mobile: false,
        platform: "Windows",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      }),
    ).toMatchObject({ platform: "windows" });
  });

  it("falls back to the desktop user agent when platform data is unavailable", () => {
    expect(
      detectMaterialReviewShortcut({
        maxTouchPoints: 0,
        platform: "",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)",
      }),
    ).toMatchObject({ platform: "mac" });
    expect(
      detectMaterialReviewShortcut({
        maxTouchPoints: 0,
        platform: "",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      }),
    ).toMatchObject({ platform: "windows" });
  });

  it.each([
    {
      label: "iPadOS posing as macOS",
      signals: {
        maxTouchPoints: 5,
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Mobile/15E148",
      },
    },
    {
      label: "iPhone",
      signals: {
        maxTouchPoints: 5,
        platform: "iPhone",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      },
    },
    {
      label: "Android",
      signals: {
        maxTouchPoints: 5,
        platform: "Linux armv8l",
        userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9)",
      },
    },
    {
      label: "mobile client hint",
      signals: {
        maxTouchPoints: 1,
        mobile: true,
        platform: "Windows",
        userAgent: "Mozilla/5.0",
      },
    },
    {
      label: "desktop Linux",
      signals: {
        maxTouchPoints: 0,
        platform: "Linux x86_64",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      },
    },
    {
      label: "ChromeOS",
      signals: {
        maxTouchPoints: 0,
        platform: "Linux x86_64",
        userAgent: "Mozilla/5.0 (X11; CrOS x86_64 16033.58.0)",
      },
    },
    {
      label: "unknown platform",
      signals: {
        maxTouchPoints: 0,
        platform: "",
        userAgent: "Mozilla/5.0",
      },
    },
  ])("does not offer the shortcut on $label", ({ signals }) => {
    expect(detectMaterialReviewShortcut(signals)).toBeNull();
  });
});

describe("isMaterialReviewShortcutEvent", () => {
  it("accepts only exact Command-Enter on macOS", () => {
    expect(
      isMaterialReviewShortcutEvent(
        { ...enterEvent, metaKey: true },
        { ariaKeyShortcuts: "Meta+Enter", keyLabel: "⌘ Enter", platform: "mac" },
      ),
    ).toBe(true);

    expect(
      isMaterialReviewShortcutEvent(
        { ...enterEvent, ctrlKey: true },
        { ariaKeyShortcuts: "Meta+Enter", keyLabel: "⌘ Enter", platform: "mac" },
      ),
    ).toBe(false);
    expect(
      isMaterialReviewShortcutEvent(
        { ...enterEvent, ctrlKey: true, metaKey: true },
        { ariaKeyShortcuts: "Meta+Enter", keyLabel: "⌘ Enter", platform: "mac" },
      ),
    ).toBe(false);
  });

  it("accepts only exact Control-Enter on Windows", () => {
    expect(
      isMaterialReviewShortcutEvent(
        { ...enterEvent, ctrlKey: true },
        {
          ariaKeyShortcuts: "Control+Enter",
          keyLabel: "Ctrl Enter",
          platform: "windows",
        },
      ),
    ).toBe(true);

    expect(
      isMaterialReviewShortcutEvent(
        { ...enterEvent, metaKey: true },
        {
          ariaKeyShortcuts: "Control+Enter",
          keyLabel: "Ctrl Enter",
          platform: "windows",
        },
      ),
    ).toBe(false);
  });

  it.each([
    { altKey: true },
    { shiftKey: true },
    { repeat: true },
    { isComposing: true },
    { key: "NumpadEnter" },
  ])("ignores composition, repeats, other keys, and extra modifiers: %o", (override) => {
    expect(
      isMaterialReviewShortcutEvent(
        { ...enterEvent, metaKey: true, ...override },
        { ariaKeyShortcuts: "Meta+Enter", keyLabel: "⌘ Enter", platform: "mac" },
      ),
    ).toBe(false);
  });
});

describe("material review shortcut wiring", () => {
  it("opts in only on the initial Describe form", () => {
    const describePage = readFileSync(
      new URL(
        "../../src/app/skills/materials/[materialId]/create/page.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    const batchPage = readFileSync(
      new URL("../../src/app/skills/batches/[batchId]/page.tsx", import.meta.url),
      "utf8",
    );

    expect(describePage).toContain("<BatchDescribeForm");
    expect(describePage).toContain("<BatchSubmitButton showReviewShortcut>");
    expect(batchPage).not.toContain("showReviewShortcut");
  });
});
