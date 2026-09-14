// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PageError } from "@/components/app/page-error";

vi.mock("next/navigation", () => ({ usePathname: () => "/practice/custom" }));
vi.mock("@/app/skills/skills-topbar", () => ({
  SkillsTopbar: ({ current }: { current: string }) => createElement("nav", { "aria-label": "Primary navigation" }, current),
}));
it("keeps navigation, focuses the error heading and supports retry and escape", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const reset = vi.fn();
  try {
    await act(async () => root.render(createElement(PageError, { reset })));
    expect(document.activeElement).toBe(host.querySelector("h1"));
    expect(host.querySelector("nav")?.textContent).toBe("practice");
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/dashboard");
    await act(async () => host.querySelector("button")!.click());
    expect(reset).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
