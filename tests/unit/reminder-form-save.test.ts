// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ReminderSettingsForm } from "@/app/settings/reminder-settings-form";

const save = vi.hoisted(() => vi.fn(async () => ({ status: "saved", message: "Saved" })));
vi.mock("@/app/settings/actions", () => ({ saveReminderSettingsAction: save }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn(), hide: vi.fn() } }));
vi.mock("@mantine/core", () => ({ Select: () => null }));
vi.mock("@/components/app/form-draft-notice", () => ({ FormDraftNotice: () => null }));
vi.mock("@/components/app/use-form-draft", async () => {
  const { useState } = await import("react");
  return { useFormDraft: (_key: string, initial: Record<string, unknown>) => {
    const [value, setValue] = useState(initial);
    return { value, ready: true, update: (patch: Record<string, unknown>) => setValue(current => ({ ...current, ...patch })), saved: vi.fn(), discard: vi.fn() };
  } };
});

it("keeps reminder toggle edits local until the user submits the form", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(ReminderSettingsForm, {
      preference: { enabled: false, email: "learner@example.com", timezone: "UTC", localHour: 9, minimumDueCount: 1 },
      practiceTimezone: "UTC",
    })));
    const toggle = host.querySelector<HTMLInputElement>('input[name="enabled"]')!;
    await act(async () => toggle.click());
    expect(toggle.checked).toBe(true);
    expect(save).not.toHaveBeenCalled();
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(save).toHaveBeenCalledOnce();
    expect((save.mock.calls[0] as unknown as [unknown, FormData])[1].get("enabled")).toBe("on");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
