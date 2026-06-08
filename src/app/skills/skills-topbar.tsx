"use client";

import { UserButton, useUser } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useRef } from "react";

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

    if (!activeLink || !navRef.current) {
      return;
    }

    navRef.current.scrollLeft = Math.max(activeLink.offsetLeft - navRef.current.offsetLeft, 0);
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
              colorPrimary: "hsl(219 97% 42%)",
            },
          }}
        />
      </div>
    </header>
  );
}

function getUserInitial(user: ReturnType<typeof useUser>["user"]) {
  const initial =
    [user?.firstName, user?.primaryEmailAddress?.emailAddress]
      .map((value) => value?.trim().charAt(0))
      .find(Boolean) ?? "L";

  return initial.toUpperCase();
}
