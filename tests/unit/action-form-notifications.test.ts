// @vitest-environment jsdom

import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { notifications, notificationsStore } from "@mantine/notifications";

import { MaterialDeleteControl } from "@/app/skills/materials/material-delete-control";
import { SkillLifecycleForm } from "@/app/skills/skill-lifecycle-form";

const { deleteMaterial } = vi.hoisted(() => ({ deleteMaterial: vi.fn() }));
vi.mock("@/app/skills/materials/actions", () => ({ deleteMaterialAction: deleteMaterial }));
vi.mock("@/app/skills/actions", () => ({ updateSkillLifecycleAction: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useActionState: () => [{ status: "saved", message: "Skill updated." }, vi.fn(), false],
}));
vi.mock("@mantine/core", async (original) => ({
  ...(await original<typeof import("@mantine/core")>()),
  Modal: ({ opened, children }: { opened: boolean; children: ReactNode }) =>
    opened ? createElement("div", { role: "dialog" }, children) : null,
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  notifications.clean();
  deleteMaterial.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  notifications.clean();
});

it("clears the material deletion error while its retry is pending", async () => {
  deleteMaterial.mockResolvedValueOnce({ status: "error", message: "Deletion failed." });
  await act(async () => root.render(createElement(MaterialDeleteControl, {
    materialId: "material-1", returnTo: "/skills/materials", title: "Study notes",
  })));
  await act(async () => container.querySelector<HTMLButtonElement>(".materialDeleteTrigger")!.click());
  const submit = container.querySelector<HTMLButtonElement>(".materialDeleteConfirm")!;
  await act(async () => submit.click());
  expect(notificationsStore.getState().notifications).toEqual([
    expect.objectContaining({ message: "Deletion failed." }),
  ]);

  let finishRetry!: (value: { status: string; message: string }) => void;
  deleteMaterial.mockImplementationOnce(() => new Promise((resolve) => { finishRetry = resolve; }));
  await act(async () => submit.click());
  try {
    expect(submit.disabled).toBe(true);
    expect(notificationsStore.getState().notifications).toEqual([]);
  } finally {
    await act(async () => finishRetry({ status: "error", message: "Please try again later." }));
  }
  expect(notificationsStore.getState().notifications).toEqual([
    expect.objectContaining({ message: "Please try again later." }),
  ]);
});

it("keeps feedback from two lifecycle actions on one skill independent", async () => {
  await act(async () => root.render(createElement(Fragment, null,
    createElement(SkillLifecycleForm, {
      skillId: "skill-1", actionType: "pause", buttonLabel: "Pause", pendingLabel: "Pausing",
    }),
    createElement(SkillLifecycleForm, {
      skillId: "skill-1", actionType: "archive", buttonLabel: "Archive", pendingLabel: "Archiving",
    }),
  )));
  const toasts = notificationsStore.getState().notifications;
  expect(toasts).toHaveLength(2);
  notifications.hide(toasts[0].id!);
  expect(notificationsStore.getState().notifications).toEqual([toasts[1]]);
});
