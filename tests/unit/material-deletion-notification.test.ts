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

import { MaterialDeletionNotification } from "@/app/skills/materials/material-deletion-notification";

describe("MaterialDeletionNotification", () => {
  it("uses a Mantine notification for queued deletion feedback", () => {
    renderToStaticMarkup(createElement(MaterialDeletionNotification, { active: true }));

    expect(showNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        className: "learnrecurNotification",
        color: "leaf",
        message: "Linked skills will remain available.",
        position: "top-right",
        title: "Material deletion queued",
        withBorder: true,
        withCloseButton: true,
      }),
    );
  });

  it("does not notify when deletion feedback is not requested", () => {
    showNotification.mockClear();
    renderToStaticMarkup(createElement(MaterialDeletionNotification, { active: false }));

    expect(showNotification).not.toHaveBeenCalled();
  });
});
