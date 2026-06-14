"use client";

import { UserButton, useUser } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useRef } from "react";

import { OpenWaterBackground, OpenWaterLogoMark } from "@/components/app/open-water";
import { designTokens } from "@/lib/design-tokens";

export function SkillsTopbar({
  current,
}: {
  current:
    | "dashboard"
    | "practice"
    | "history"
    | "skills"
    | "collections"
    | "settings"
    | "new"
    | "skill";
}) {
  const navRef = useRef<HTMLElement | null>(null);
  const { user } = useUser();
  const userInitial = getUserInitial(user);
  const hasCustomAvatar = user?.hasImage === true;

  useEffect(() => {
    const activeLink = navRef.current?.querySelector<HTMLAnchorElement>(
      'a[aria-current="page"]',
    );

    if (!activeLink || typeof activeLink.scrollIntoView !== "function") {
      return;
    }

    activeLink.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);

  return (
    <>
      <OpenWaterBackground />
      <header className="practiceTopbar">
        <Link className="practiceWordmark" href="/dashboard">
          <OpenWaterLogoMark />
          <span>LearnRecur</span>
        </Link>
        <div className="practiceTopbarRight">
          <nav ref={navRef} className="practiceNav" aria-label="Primary navigation">
            <Link aria-current={current === "dashboard" ? "page" : undefined} href="/dashboard">
              Dashboard
            </Link>
            <Link aria-current={current === "practice" ? "page" : undefined} href="/practice">
              Practice
            </Link>
            <Link aria-current={current === "history" ? "page" : undefined} href="/history">
              History
            </Link>
            <Link
              aria-current={current === "skills" || current === "skill" ? "page" : undefined}
              href="/skills"
            >
              Skills
            </Link>
            <Link aria-current={current === "collections" ? "page" : undefined} href="/collections">
              Collections
            </Link>
            <Link
              aria-current={current === "new" ? "page" : undefined}
              data-intent="create"
              href="/skills/new"
            >
              Add
            </Link>
            <Link aria-current={current === "settings" ? "page" : undefined} href="/settings">
              Settings
            </Link>
          </nav>
          <div
            className="practiceUserMenu"
            data-custom-avatar={hasCustomAvatar}
            data-initial={userInitial}
          >
            <UserButton
              appearance={{
                elements: {
                  userButtonAvatarBox: "learnrecurUserAvatar",
                  userButtonTrigger: "learnrecurUserButton",
                },
                variables: {
                  colorPrimary: designTokens.colorPrimary,
                },
              }}
            />
          </div>
        </div>
      </header>
    </>
  );
}

// "L" intentionally falls back to the LearnRecur initial when Clerk has no name or email.
function getUserInitial(user: ReturnType<typeof useUser>["user"]) {
  const initial =
    [user?.firstName, user?.primaryEmailAddress?.emailAddress]
      .map((value) => value?.trim().charAt(0))
      .find(Boolean) ?? "L";

  return initial.toUpperCase();
}
