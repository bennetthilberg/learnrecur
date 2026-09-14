// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { useFormDraft } from "@/components/app/use-form-draft";
const auth = vi.hoisted(() => ({ userId: "alice" }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
const schema = z.object({ title: z.string() });
let current: ReturnType<typeof useFormDraft<{ title: string }>>;
function Form({ title = "Saved" }: { title?: string }) {
  const draft = useFormDraft("settings", { title }, schema);
  useEffect(() => { current = draft; }, [draft]);
  return createElement("p", {}, draft.value.title);
}
afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); auth.userId = "alice"; });
it("restores drafts, clears acknowledged changes, and respects new saved data and account changes", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host);
  let root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Form)));
    await act(async () => current.update({ title: "Unfinished" }));
    expect(current.dirty).toBe(true);
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(createElement(Form)));
    expect(current.restored).toBe(true);
    expect(current.value.title).toBe("Unfinished");
    await act(async () => current.saved());
    expect(current.dirty).toBe(false);
    await act(async () => current.update({ title: "Another edit" }));
    await act(async () => current.discard());
    expect(current.value.title).toBe("Unfinished");
    await act(async () => current.update({ title: "Stale edit" }));
    await act(async () => root.render(createElement(Form, { title: "Changed on server" })));
    expect(current.value.title).toBe("Changed on server");
    await act(async () => current.update({ title: "Alice draft" }));
    auth.userId = "bob";
    await act(async () => root.render(createElement(Form, { title: "Bob saved" })));
    expect(current.value.title).toBe("Bob saved");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
it("warns before leaving when a draft cannot be stored", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const link = document.createElement("a"); link.href = "/dashboard"; document.body.append(link);
  try {
    await act(async () => root.render(createElement(Form)));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => current.update({ title: "Important edit" }));
    expect(current.stored).toBe(false);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  } finally { await act(async () => root.unmount()); host.remove(); link.remove(); }
});
