"use client";

import { UserButton } from "@clerk/nextjs";
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

  useEffect(() => {
    const activeLink = navRef.current?.querySelector<HTMLAnchorElement>(
      'a[aria-current="page"]',
    );

    activeLink?.scrollIntoView({
      block: "nearest",
      inline: "start",
    });
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
      <div className="practiceUserMenu">
        <UserButton />
      </div>
    </header>
  );
}
