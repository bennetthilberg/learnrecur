"use client";

import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { useEffect, useRef } from "react";
import {
  Cards,
  ClockCounterClockwise,
  Folders,
  Gauge,
  GearSix,
  PlayCircle,
  PlusCircle,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";

import { OpenWaterBackground, OpenWaterLogoMark } from "@/components/app/open-water";
import { designTokens } from "@/lib/design-tokens";

const navItems: {
  href: string;
  label: string;
  key: "dashboard" | "practice" | "history" | "skills" | "collections" | "settings" | "new";
  icon: Icon;
  isCurrent: (current: SkillsTopbarCurrent) => boolean;
  intent?: "create";
}[] = [
  {
    href: "/dashboard",
    label: "Dashboard",
    key: "dashboard",
    icon: Gauge,
    isCurrent: (current) => current === "dashboard",
  },
  {
    href: "/practice",
    label: "Practice",
    key: "practice",
    icon: PlayCircle,
    isCurrent: (current) => current === "practice",
  },
  {
    href: "/history",
    label: "History",
    key: "history",
    icon: ClockCounterClockwise,
    isCurrent: (current) => current === "history",
  },
  {
    href: "/skills",
    label: "Skills",
    key: "skills",
    icon: Cards,
    isCurrent: (current) => current === "skills" || current === "skill",
  },
  {
    href: "/collections",
    label: "Collections",
    key: "collections",
    icon: Folders,
    isCurrent: (current) => current === "collections",
  },
  {
    href: "/skills/new",
    label: "Add",
    key: "new",
    icon: PlusCircle,
    isCurrent: (current) => current === "new",
    intent: "create",
  },
  {
    href: "/settings",
    label: "Settings",
    key: "settings",
    icon: GearSix,
    isCurrent: (current) => current === "settings",
  },
];

type SkillsTopbarCurrent =
  | "dashboard"
  | "practice"
  | "history"
  | "skills"
  | "collections"
  | "settings"
  | "new"
  | "skill";

export function SkillsTopbar({
  current,
}: {
  current: SkillsTopbarCurrent;
}) {
  const navRef = useRef<HTMLElement | null>(null);

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
            {navItems.map((item) => {
              const NavIcon = item.icon;

              return (
                <Link
                  aria-current={item.isCurrent(current) ? "page" : undefined}
                  data-intent={item.intent}
                  href={item.href}
                  key={item.key}
                >
                  <NavIcon
                    aria-hidden="true"
                    className="practiceNavIcon"
                    size={18}
                    weight="regular"
                  />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
          <div className="practiceUserMenu">
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
