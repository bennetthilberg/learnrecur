import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const formStatus = vi.hoisted(() => ({ pending: false }));
const describeShortcut = vi.hoisted(() => ({
  current: null as null | {
    ariaKeyShortcuts: "Meta+Enter" | "Control+Enter";
    keyLabel: string;
    platform: "mac" | "windows";
  },
}));

vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  useFormStatus: () => ({ pending: formStatus.pending }),
}));

vi.mock("@/app/skills/batches/batch-describe-form", () => ({
  useBatchDescribeShortcut: () => describeShortcut.current,
}));

import { BatchSubmitButton } from "@/app/skills/batches/batch-submit-button";

function renderButton(
  props: Omit<React.ComponentProps<typeof BatchSubmitButton>, "children"> | null,
  label = "Review scope",
) {
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(BatchSubmitButton, props, label),
    ),
  );
}

describe("BatchSubmitButton", () => {
  it("shows the detected desktop shortcut only when the button opts in", () => {
    formStatus.pending = false;
    describeShortcut.current = {
      ariaKeyShortcuts: "Meta+Enter",
      keyLabel: "⌘ Enter",
      platform: "mac",
    };

    const optedInMarkup = renderButton({ showReviewShortcut: true });
    const defaultMarkup = renderButton(null);

    expect(optedInMarkup).toContain('aria-keyshortcuts="Meta+Enter"');
    expect(optedInMarkup).toContain("Review scope");
    expect(optedInMarkup).toContain("⌘ Enter");
    expect(optedInMarkup).toContain("batchSubmitShortcut");
    expect(optedInMarkup).toContain("<kbd");
    expect(optedInMarkup).toContain("<svg");
    expect(defaultMarkup).not.toContain("aria-keyshortcuts");
    expect(defaultMarkup).not.toContain("batchSubmitShortcut");
  });

  it("does not render a shortcut affordance on unsupported platforms", () => {
    formStatus.pending = false;
    describeShortcut.current = null;

    const markup = renderButton({ showReviewShortcut: true });

    expect(markup).not.toContain("aria-keyshortcuts");
    expect(markup).not.toContain("batchSubmitShortcut");
  });

  it("keeps the visible action label and adds a spinner while pending", () => {
    formStatus.pending = true;
    describeShortcut.current = {
      ariaKeyShortcuts: "Control+Enter",
      keyLabel: "Ctrl Enter",
      platform: "windows",
    };

    const markup = renderButton({ showReviewShortcut: true });

    expect(markup).toContain("Review scope");
    expect(markup).not.toContain("Resolving the scope");
    expect(markup).toContain("buttonSpinner");
    expect(markup).toContain("aria-busy=\"true\"");
    expect(markup).toContain("disabled");
    expect(markup).toContain("Ctrl Enter");
  });
});
