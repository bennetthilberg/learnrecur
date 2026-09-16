// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { PageError } from "@/components/app/page-error";

const route = vi.hoisted(() => ({ pathname: "/practice/custom" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
vi.mock("@/app/skills/skills-topbar", () => ({
  SkillsTopbar: ({ current }: { current: string }) => createElement("nav", { "aria-label": "Primary navigation" }, current),
}));
it.each([
  ["/dashboard", "dashboard", "/skills"],
  ["/practice/custom", "practice", "/dashboard"],
  ["/history", "history", "/dashboard"],
  ["/skills/example", "skills", "/dashboard"],
  ["/skills/new/one", "new", "/dashboard"],
  ["/collections", "collections", "/dashboard"],
  ["/settings", "settings", "/dashboard"],
])("keeps %s navigation, focuses the error and supports retry and escape", async (pathname, current, escape) => {
  route.pathname = pathname;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const reset = vi.fn();
  try {
    await act(async () => root.render(createElement(PageError, { reset })));
    expect(document.activeElement).toBe(host.querySelector("h1"));
    expect(host.querySelector("nav")?.textContent).toBe(current);
    expect(host.querySelector("a")?.getAttribute("href")).toBe(escape);
    await act(async () => host.querySelector("button")!.click());
    expect(reset).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
