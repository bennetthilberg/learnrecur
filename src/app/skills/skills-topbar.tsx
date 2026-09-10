"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
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
import { AccountMenu } from "@/components/auth/account-menu";

import {
  PrimaryRouteLoadingContent,
  primaryRouteLoadingByKey,
} from "./primary-route-loading-content";

function scrollNavLinkIntoView(nav: HTMLElement, link: HTMLElement) {
  if (nav.scrollWidth <= nav.clientWidth + 1) {
    return;
  }

  const navRect = nav.getBoundingClientRect();
  const linkRect = link.getBoundingClientRect();
  const safeInset = 8;

  if (linkRect.left < navRect.left + safeInset) {
    nav.scrollLeft += linkRect.left - navRect.left - safeInset;
  } else if (linkRect.right > navRect.right - safeInset) {
    nav.scrollLeft += linkRect.right - navRect.right + safeInset;
  }
}

const navItems: {
  href: string;
  label: string;
  key: "dashboard" | "practice" | "history" | "skills" | "collections" | "settings" | "new";
  icon: Icon;
  isCurrent: (current: SkillsTopbarCurrent) => boolean;
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
  },
  {
    href: "/settings",
    label: "Settings",
    key: "settings",
    icon: GearSix,
    isCurrent: (current) => current === "settings",
  },
];

export type SkillsTopbarCurrent =
  | "dashboard"
  | "practice"
  | "history"
  | "skills"
  | "collections"
  | "settings"
  | "new"
  | "skill";

type PrimaryNavKey = Exclude<SkillsTopbarCurrent, "skill">;

function isPrimaryUnmodifiedEvent(
  event: MouseEvent<HTMLAnchorElement>,
) {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function SkillsTopbar({
  current,
}: {
  current: SkillsTopbarCurrent;
}) {
  const router = useRouter();
  const navRef = useRef<HTMLElement | null>(null);
  const currentNavKey = navItems.find((item) => item.isCurrent(current))?.key;
  const [pendingNavKey, setPendingNavKey] = useState<PrimaryNavKey | null>(null);
  const pendingNavKeyRef = useRef<PrimaryNavKey | null>(null);
  const visualNavKey = pendingNavKey ?? currentNavKey;
  const pendingConfig = pendingNavKey ? primaryRouteLoadingByKey[pendingNavKey] : null;

  const prefetchNavRoute = useCallback(
    (href: string) => {
      router.prefetch(href);
    },
    [router],
  );

  useLayoutEffect(() => {
    const scrollActiveLink = () => {
      const nav = navRef.current;
      const activeLink = nav?.querySelector<HTMLAnchorElement>('a[data-nav-active="true"]');
      if (nav && activeLink) {
        scrollNavLinkIntoView(nav, activeLink);
      }
    };

    scrollActiveLink();
    window.addEventListener("resize", scrollActiveLink);
    return () => window.removeEventListener("resize", scrollActiveLink);
  }, [visualNavKey]);

  const handleNavClick = useCallback(
    (targetKey: PrimaryNavKey, href: string, event: MouseEvent<HTMLAnchorElement>) => {
      if (!isPrimaryUnmodifiedEvent(event)) {
        return;
      }

      const pendingBeforeClick = pendingNavKeyRef.current;
      const isCurrentRouteClick = currentNavKey === targetKey;

      if (!pendingBeforeClick && isCurrentRouteClick) {
        return;
      }

      event.preventDefault();

      const shell = event.currentTarget.closest<HTMLElement>(
        ".dashboardShell, .practiceShell, .skillShell",
      );

      if (isCurrentRouteClick) {
        shell?.removeAttribute("data-route-pending");
        pendingNavKeyRef.current = null;
        setPendingNavKey(null);
        router.replace(href);

        return;
      }

      shell?.setAttribute("data-route-pending", "true");
      pendingNavKeyRef.current = targetKey;
      setPendingNavKey(targetKey);

      if (pendingBeforeClick) {
        router.replace(href);
      } else {
        router.push(href);
      }
    },
    [currentNavKey, router],
  );

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
              const isCurrentPage = item.isCurrent(current);
              const isVisuallyActive = visualNavKey === item.key;

              return (
                <Link
                  aria-current={isCurrentPage ? "page" : undefined}
                  data-nav-active={isVisuallyActive ? "true" : undefined}
                  data-nav-key={item.key}
                  href={item.href}
                  key={item.key}
                  onClick={(event) => handleNavClick(item.key, item.href, event)}
                  onFocus={() => prefetchNavRoute(item.href)}
                  onPointerDown={() => {
                    prefetchNavRoute(item.href);
                  }}
                  onPointerEnter={() => prefetchNavRoute(item.href)}
                  prefetch={false}
                >
                  <NavIcon
                    aria-hidden="true"
                    className="practiceNavIcon"
                    size={18}
                    weight="regular"
                  />
                  <span className="practiceNavLabel" data-label={item.label}>
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </nav>
          <AccountMenu />
        </div>
      </header>
      {pendingConfig ? (
        <div
          className={
            pendingConfig.kind === "history"
              ? "routePendingContent historyShell"
              : pendingConfig.kind === "settings"
                ? "routePendingContent settingsShell"
                : pendingConfig.kind === "new"
                  ? "routePendingContent createSkillShell"
                  : "routePendingContent"
          }
          data-route-kind={pendingConfig.kind}
          aria-live="polite"
        >
          <PrimaryRouteLoadingContent config={pendingConfig} />
        </div>
      ) : null}
    </>
  );
}
