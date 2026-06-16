"use client";

import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
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
import { designTokens } from "@/lib/design-tokens";

const previousNavKeyStorage = "learnrecur:previous-primary-nav-key";
const skipNavMountAnimationStorage = "learnrecur:skip-primary-nav-mount-animation";

function setNavIndicatorFromLink(nav: HTMLElement, link: HTMLElement) {
  const navRect = nav.getBoundingClientRect();
  const linkRect = link.getBoundingClientRect();

  nav.style.setProperty(
    "--practice-nav-indicator-x",
    `${linkRect.left - navRect.left + nav.scrollLeft}px`,
  );
  nav.style.setProperty(
    "--practice-nav-indicator-y",
    `${linkRect.top - navRect.top + nav.scrollTop}px`,
  );
  nav.style.setProperty("--practice-nav-indicator-width", `${linkRect.width}px`);
  nav.style.setProperty("--practice-nav-indicator-height", `${linkRect.height}px`);
  nav.style.setProperty("--practice-nav-indicator-opacity", "1");
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
  const router = useRouter();
  const navRef = useRef<HTMLElement | null>(null);
  const activeIndicatorRef = useRef<HTMLSpanElement | null>(null);
  const previousNavKeyRef = useRef<string | null>(null);
  const currentNavKey = navItems.find((item) => item.isCurrent(current))?.key;

  const positionActiveIndicator = useCallback(
    (animate: boolean) => {
      const nav = navRef.current;
      const indicator = activeIndicatorRef.current;
      const activeLink = nav?.querySelector<HTMLAnchorElement>('a[aria-current="page"]');

      if (!nav || !indicator || !activeLink) {
        return;
      }

      const skipMountAnimation =
        window.sessionStorage.getItem(skipNavMountAnimationStorage) === "true";
      const storedPreviousKey = window.sessionStorage.getItem(previousNavKeyStorage);
      const previousNavKey =
        !skipMountAnimation && storedPreviousKey && storedPreviousKey !== currentNavKey
          ? storedPreviousKey
          : previousNavKeyRef.current;
      const previousLink =
        animate && previousNavKey && previousNavKey !== currentNavKey
          ? nav.querySelector<HTMLAnchorElement>(`a[data-nav-key="${previousNavKey}"]`)
          : null;

      if (previousLink && previousLink !== activeLink) {
        indicator.style.transition = "none";
        setNavIndicatorFromLink(nav, previousLink);
        indicator.getBoundingClientRect();
        window.requestAnimationFrame(() => {
          indicator.style.transition = "";
          setNavIndicatorFromLink(nav, activeLink);
        });
      } else {
        indicator.style.transition = "none";
        setNavIndicatorFromLink(nav, activeLink);
        window.requestAnimationFrame(() => {
          indicator.style.transition = "";
        });
      }

      window.sessionStorage.removeItem(previousNavKeyStorage);
      window.sessionStorage.removeItem(skipNavMountAnimationStorage);
      previousNavKeyRef.current = currentNavKey ?? null;

      if (typeof activeLink.scrollIntoView === "function") {
        activeLink.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    },
    [currentNavKey],
  );

  useLayoutEffect(() => {
    positionActiveIndicator(true);
  }, [positionActiveIndicator]);

  useEffect(() => {
    const handleViewportChange = () => {
      positionActiveIndicator(false);
    };

    window.addEventListener("resize", handleViewportChange);

    return () => {
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [positionActiveIndicator]);

  useEffect(() => {
    const prefetchPrimaryRoutes = () => {
      for (const item of navItems) {
        if (item.key !== currentNavKey) {
          router.prefetch(item.href);
        }
      }
    };
    const idleWindow = window as Window & {
      cancelIdleCallback?: (handle: number) => void;
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
    };

    if (idleWindow.requestIdleCallback) {
      const idleHandle = idleWindow.requestIdleCallback(prefetchPrimaryRoutes, {
        timeout: 2500,
      });

      return () => {
        idleWindow.cancelIdleCallback?.(idleHandle);
      };
    }

    const timeoutHandle = window.setTimeout(prefetchPrimaryRoutes, 400);

    return () => {
      window.clearTimeout(timeoutHandle);
    };
  }, [currentNavKey, router]);

  const handleNavClick = useCallback(
    (targetKey: string, event: MouseEvent<HTMLAnchorElement>) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      if (currentNavKey && currentNavKey !== targetKey) {
        window.sessionStorage.setItem(previousNavKeyStorage, currentNavKey);

        const nav = navRef.current;
        const indicator = activeIndicatorRef.current;
        const targetLink = event.currentTarget;

        if (nav) {
          nav.querySelectorAll<HTMLAnchorElement>("a[data-nav-active]").forEach((link) => {
            link.removeAttribute("data-nav-active");
          });
          targetLink.setAttribute("data-nav-active", "true");
        }

        if (nav && indicator && targetLink) {
          indicator.style.transition = "";
          setNavIndicatorFromLink(nav, targetLink);
          window.sessionStorage.setItem(skipNavMountAnimationStorage, "true");
        }
      }
    },
    [currentNavKey],
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
            <span ref={activeIndicatorRef} className="practiceNavActiveIndicator" aria-hidden="true" />
            {navItems.map((item) => {
              const NavIcon = item.icon;
              const isCurrentPage = item.isCurrent(current);

              return (
                <Link
                  aria-current={isCurrentPage ? "page" : undefined}
                  data-nav-active={isCurrentPage ? "true" : undefined}
                  data-nav-key={item.key}
                  href={item.href}
                  key={item.key}
                  onClick={(event) => handleNavClick(item.key, event)}
                  onPointerEnter={() => router.prefetch(item.href)}
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
