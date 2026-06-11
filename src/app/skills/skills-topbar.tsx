"use client";

import { UserButton, useUser } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useRef } from "react";

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
    <header className="practiceTopbar">
      <Link className="practiceWordmark" href="/dashboard">
        LearnRecur
      </Link>
      <nav ref={navRef} className="practiceNav" aria-label="Primary navigation">
        <div className="practiceNavGroup">
          <span className="practiceNavSection" aria-hidden="true">
            Practice loop
          </span>
          <Link aria-current={current === "dashboard" ? "page" : undefined} href="/dashboard">
            Dashboard
          </Link>
          <Link aria-current={current === "practice" ? "page" : undefined} href="/practice">
            Practice
          </Link>
          <Link aria-current={current === "history" ? "page" : undefined} href="/history">
            History
          </Link>
        </div>
        <div className="practiceNavGroup">
          <span className="practiceNavSection" aria-hidden="true">
            Content
          </span>
          {/* Keep Skills highlighted on both the index and individual skill pages. */}
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
            Add skill
          </Link>
        </div>
        <div className="practiceNavGroup">
          <span className="practiceNavSection" aria-hidden="true">
            Account
          </span>
          <Link aria-current={current === "settings" ? "page" : undefined} href="/settings">
            Settings
          </Link>
        </div>
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
              colorPrimary: designTokens.colorPrimaryHsl,
            },
          }}
        />
      </div>
    </header>
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
