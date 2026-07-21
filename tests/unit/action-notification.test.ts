import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { showNotification } = vi.hoisted(() => ({ showNotification: vi.fn() }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void) => effect(),
}));

vi.mock("@mantine/notifications", () => ({
  notifications: { show: showNotification },
}));

import { ActionNotification } from "@/components/app/action-notification";

describe("ActionNotification", () => {
  it("shows transient errors through Mantine notifications", () => {
    renderToStaticMarkup(
      createElement(ActionNotification, {
        id: "scope-planning-error",
        message: "LearnRecur could not review that scope.",
        title: "Could not review scope",
        tone: "error",
      }),
    );

    expect(showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        className: "learnrecurNotification",
        color: "red",
        id: "scope-planning-error",
        message: "LearnRecur could not review that scope.",
        position: "top-right",
        title: "Could not review scope",
        withBorder: true,
        withCloseButton: true,
      }),
    );
  });

  it("does not show an empty notification", () => {
    showNotification.mockClear();
    renderToStaticMarkup(
      createElement(ActionNotification, {
        id: "scope-planning-error",
        message: undefined,
        title: "Could not review scope",
        tone: "error",
      }),
    );

    expect(showNotification).not.toHaveBeenCalled();
  });
});
