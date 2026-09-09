import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { notifications, notificationsStore } from "@mantine/notifications";

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void) => effect(),
}));

import { ActionNotification } from "@/components/app/action-notification";

describe("ActionNotification", () => {
  beforeEach(() => notifications.clean());

  it("shows transient errors through Mantine notifications", () => {
    renderToStaticMarkup(
      createElement(ActionNotification, {
        id: "scope-planning-error",
        message: "LearnRecur could not review that scope.",
        title: "Could not review scope",
        tone: "error",
      }),
    );

    expect(notificationsStore.getState().notifications).toEqual([
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
    ]);
  });

  it("does not show an empty notification", () => {
    renderToStaticMarkup(
      createElement(ActionNotification, {
        id: "scope-planning-error",
        message: undefined,
        title: "Could not review scope",
        tone: "error",
      }),
    );

    expect(notificationsStore.getState().notifications).toEqual([]);
  });
});

describe("notification retries", () => {
  beforeEach(() => notifications.clean());

  function report(message: string | null, tone: "success" | "error" = "error") {
    renderToStaticMarkup(createElement(ActionNotification, {
      id: "collection-action", title: "Collection", message, tone,
    }));
  }

  it("removes the old error when a retry clears its message", () => {
    report("Collection name is required.");
    report(null);
    expect(notificationsStore.getState().notifications).toEqual([]);
    report("Collection created.", "success");
    expect(notificationsStore.getState().notifications).toEqual([
      expect.objectContaining({ id: "collection-action", message: "Collection created.", color: "leaf" }),
    ]);
  });

  it("replaces an existing message with the latest result without manual dismissal", () => {
    report("Could not save collection.");
    report("Collection saved.", "success");
    expect(notificationsStore.getState().notifications).toEqual([
      expect.objectContaining({ id: "collection-action", message: "Collection saved.", color: "leaf" }),
    ]);
  });
});
