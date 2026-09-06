// @vitest-environment jsdom

import { act, createElement, Fragment } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountMenu } from "@/components/auth/account-menu";

const clerk = vi.hoisted(() => ({ loaded: false, openMenu: vi.fn() }));

vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({
    isLoaded: clerk.loaded,
    user: clerk.loaded
      ? { fullName: "Alpha Learner", primaryEmailAddress: { emailAddress: "learner@example.com" } }
      : null,
  }),
  // Clerk renders its fallback on the server, then adds a widget host as soon
  // as its browser SDK is ready. It can be ready before React hydrates.
  UserButton: ({ fallback }: { fallback: React.ReactNode }) =>
    createElement(
      Fragment,
      null,
      fallback,
      clerk.loaded
        ? createElement(
            "div",
            { "data-clerk-component": "UserButton" },
            createElement("button", { className: "learnrecurUserButton", onClick: clerk.openMenu }),
          )
        : null,
    ),
}));

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  clerk.loaded = false;
  clerk.openMenu.mockClear();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  container.remove();
});

describe("account menu hydration", () => {
  it("preserves server markup when Clerk loads before hydration and opens the account menu", async () => {
    container.innerHTML = renderToString(createElement(AccountMenu));
    const serverProfile = container.querySelector(".practiceUserProfile");
    clerk.loaded = true;
    const onRecoverableError = vi.fn();

    await act(async () => {
      root = hydrateRoot(container, createElement(AccountMenu), { onRecoverableError });
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(container.querySelector(".practiceUserProfile")).toBe(serverProfile);
    expect(container.querySelector(".learnrecurUserButton")).not.toBeNull();
    expect(container.querySelector(".practiceUserName")?.textContent).toBe("Alpha Learner");
    expect(container.querySelector(".practiceUserMeta")?.textContent).toBe("learner@example.com");

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".practiceUserIdentity")?.click();
    });
    expect(clerk.openMenu).toHaveBeenCalledOnce();
  });

  it("keeps the avatar fallback until a slow Clerk SDK becomes ready", async () => {
    container.innerHTML = renderToString(createElement(AccountMenu));
    const onRecoverableError = vi.fn();

    await act(async () => {
      root = hydrateRoot(container, createElement(AccountMenu), { onRecoverableError });
    });

    expect(container.querySelector(".practiceUserFallbackAvatar")?.textContent).toBe("A");
    expect(container.querySelector(".learnrecurUserButton")).toBeNull();
    expect(container.querySelector(".practiceUserMeta")?.textContent).toBe("Loading profile");

    clerk.loaded = true;
    await act(async () => root?.render(createElement(AccountMenu)));

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(container.querySelector(".learnrecurUserButton")).not.toBeNull();
    expect(container.querySelector(".practiceUserName")?.textContent).toBe("Alpha Learner");
  });
});
