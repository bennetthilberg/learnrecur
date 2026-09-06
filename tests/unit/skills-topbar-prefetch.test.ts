// @vitest-environment jsdom

import { act, createElement, type AnchorHTMLAttributes } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { SkillsTopbar } from "@/app/skills/skills-topbar";

const router = vi.hoisted(() => ({ prefetch: vi.fn(), push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/auth/account-menu", () => ({ AccountMenu: () => null }));
vi.mock("next/link", () => ({
  default: ({ prefetch, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { prefetch?: boolean }) =>
    createElement("a", { ...props, "data-prefetch": String(prefetch) }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("prefetches the route a learner focuses without eagerly loading every private page", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(SkillsTopbar, { current: "dashboard" })));
    await act(async () => vi.advanceTimersByTime(200));

    expect(router.prefetch).not.toHaveBeenCalled();
    const links = container.querySelectorAll<HTMLAnchorElement>(".practiceNav a");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.dataset.prefetch).toBe("false");

    const skills = container.querySelector<HTMLAnchorElement>('a[href="/skills"]');
    await act(async () => skills?.focus());
    expect(router.prefetch).toHaveBeenCalledExactlyOnceWith("/skills");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
