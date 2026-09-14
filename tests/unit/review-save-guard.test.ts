// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { confirmReviewSave, useReviewSaveGuard } from "@/app/practice/use-review-save-guard";
const { router } = vi.hoisted(() => ({ router: { push: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
it("remembers a navigation request and opens it only after a successful acknowledgement", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let guard!: ReturnType<typeof useReviewSaveGuard>;
  function Harness({ saving }: { saving: boolean }) {
    guard = useReviewSaveGuard(saving);
    return createElement("div", {}, createElement("a", { href: "/dashboard" }, "Dashboard"), guard.navigationMessage);
  }
  try {
    await act(async () => root.render(createElement(Harness, { saving: true })));
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(async () => { host.querySelector("a")!.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(host.textContent).toContain("Saving your review");
    expect(router.push).not.toHaveBeenCalled();
    await act(async () => { guard.finishSave(false); root.render(createElement(Harness, { saving: false })); });
    expect(router.push).not.toHaveBeenCalled();
    await act(async () => root.render(createElement(Harness, { saving: true })));
    await act(async () => { guard.finishSave(true); root.render(createElement(Harness, { saving: false })); });
    expect(router.push).toHaveBeenCalledWith(host.querySelector("a")!.href);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
it("releases an unconfirmed save for retry without applying its late response", async () => {
  vi.useFakeTimers();
  try {
    let resolve!: (value: string) => void;
    const request = new Promise<string>(done => { resolve = done; });
    const bounded = confirmReviewSave(request, 100);
    const rejected = expect(bounded).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(101); await rejected;
    resolve("late acknowledgement");
    await expect(bounded).rejects.toThrow("timed out");
    await expect(confirmReviewSave(Promise.resolve("saved"), 100)).resolves.toBe("saved");
  } finally { vi.useRealTimers(); }
});
