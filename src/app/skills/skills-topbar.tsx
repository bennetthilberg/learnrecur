"use client";

import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";
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

import {
  PrimaryRouteLoadingContent,
  primaryRouteLoadingByKey,
} from "./primary-route-loading-content";

const floatingIndicatorActiveClass = "practiceNavFloatingActive";
const floatingIndicatorClass = "practiceNavFloatingIndicator";
let floatingIndicatorElement: HTMLSpanElement | null = null;
let floatingIndicatorFrame: number | null = null;
let floatingIndicatorTimeout: number | null = null;

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

function setFloatingIndicatorRect(element: HTMLElement, rect: DOMRect) {
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
  element.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
}

function clearFloatingIndicatorTimer() {
  if (floatingIndicatorTimeout !== null) {
    window.clearTimeout(floatingIndicatorTimeout);
    floatingIndicatorTimeout = null;
  }
}

function clearFloatingIndicatorFrame() {
  if (floatingIndicatorFrame !== null) {
    window.cancelAnimationFrame(floatingIndicatorFrame);
    floatingIndicatorFrame = null;
  }
}

function finishFloatingIndicator() {
  clearFloatingIndicatorFrame();
  clearFloatingIndicatorTimer();
  document.body.classList.remove(floatingIndicatorActiveClass);
  floatingIndicatorElement?.remove();
  floatingIndicatorElement = null;
}

function getFloatingIndicatorStartRect(nav: HTMLElement, targetLink: HTMLElement) {
  if (floatingIndicatorElement) {
    return floatingIndicatorElement.getBoundingClientRect();
  }

  const localIndicator = nav.querySelector<HTMLElement>(".practiceNavActiveIndicator");
  const indicatorRect = localIndicator?.getBoundingClientRect();

  if (localIndicator && indicatorRect && indicatorRect.width > 0 && indicatorRect.height > 0) {
    return indicatorRect;
  }

  const activeLink =
    nav.querySelector<HTMLElement>('a[data-nav-active="true"]') ??
    nav.querySelector<HTMLElement>('a[aria-current="page"]');

  return (activeLink ?? targetLink).getBoundingClientRect();
}

function moveFloatingIndicatorToLink(targetLink: HTMLElement) {
  const nav = targetLink.closest<HTMLElement>(".practiceNav");
  const localIndicator = nav?.querySelector<HTMLElement>(".practiceNavActiveIndicator");

  if (!nav || !localIndicator || getComputedStyle(localIndicator).display === "none") {
    return;
  }

  const startRect = getFloatingIndicatorStartRect(nav, targetLink);
  const targetRect = targetLink.getBoundingClientRect();

  if (!floatingIndicatorElement) {
    floatingIndicatorElement = document.createElement("span");
    floatingIndicatorElement.className = floatingIndicatorClass;
    floatingIndicatorElement.setAttribute("aria-hidden", "true");
    document.body.appendChild(floatingIndicatorElement);
  }

  clearFloatingIndicatorFrame();
  clearFloatingIndicatorTimer();
  document.body.classList.add(floatingIndicatorActiveClass);
  floatingIndicatorElement.style.transition = "none";
  setFloatingIndicatorRect(floatingIndicatorElement, startRect);
  floatingIndicatorElement.getBoundingClientRect();

  floatingIndicatorFrame = window.requestAnimationFrame(() => {
    floatingIndicatorFrame = null;

    if (!floatingIndicatorElement) {
      return;
    }

    floatingIndicatorElement.style.transition = "";
    setFloatingIndicatorRect(floatingIndicatorElement, targetRect);
  });

  floatingIndicatorTimeout = window.setTimeout(finishFloatingIndicator, 240);
}

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
  event: MouseEvent<HTMLAnchorElement> | PointerEvent<HTMLAnchorElement>,
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
  const activeIndicatorRef = useRef<HTMLSpanElement | null>(null);
  const indicatorFrameRef = useRef<number | null>(null);
  const currentNavKey = navItems.find((item) => item.isCurrent(current))?.key;
  const [pendingNavKey, setPendingNavKey] = useState<PrimaryNavKey | null>(null);
  const pendingNavKeyRef = useRef<PrimaryNavKey | null>(null);
  const [visualNavKey, setVisualNavKey] = useState<PrimaryNavKey | undefined>(currentNavKey);
  const visualNavKeyRef = useRef<PrimaryNavKey | undefined>(currentNavKey);
  const pendingConfig = pendingNavKey ? primaryRouteLoadingByKey[pendingNavKey] : null;

  const prefetchNavRoute = useCallback(
    (href: string) => {
      router.prefetch(href);
    },
    [router],
  );

  const cancelIndicatorFrame = useCallback(() => {
    if (indicatorFrameRef.current !== null) {
      window.cancelAnimationFrame(indicatorFrameRef.current);
      indicatorFrameRef.current = null;
    }
  }, []);

  const queueIndicatorFrame = useCallback(
    (callback: () => void) => {
      cancelIndicatorFrame();
      indicatorFrameRef.current = window.requestAnimationFrame(() => {
        indicatorFrameRef.current = null;
        callback();
      });
    },
    [cancelIndicatorFrame],
  );

  const positionActiveIndicator = useCallback(
    () => {
      const nav = navRef.current;
      const indicator = activeIndicatorRef.current;
      const activeLink =
        nav?.querySelector<HTMLAnchorElement>('a[data-nav-active="true"]') ??
        nav?.querySelector<HTMLAnchorElement>('a[aria-current="page"]');

      if (!nav || !indicator || !activeLink) {
        return;
      }

      scrollNavLinkIntoView(nav, activeLink);
      cancelIndicatorFrame();
      indicator.style.transition = "none";
      setNavIndicatorFromLink(nav, activeLink);
      queueIndicatorFrame(() => {
        indicator.style.transition = "";
      });
    },
    [cancelIndicatorFrame, queueIndicatorFrame],
  );

  const moveVisualIndicator = useCallback((targetKey: PrimaryNavKey, targetLink: HTMLElement) => {
    visualNavKeyRef.current = targetKey;
    setVisualNavKey(targetKey);

    const nav = navRef.current;
    const indicator = activeIndicatorRef.current;

    if (nav && indicator) {
      cancelIndicatorFrame();
      scrollNavLinkIntoView(nav, targetLink);
      indicator.style.transition = "";
      setNavIndicatorFromLink(nav, targetLink);
    }
  }, [cancelIndicatorFrame]);

  useEffect(() => {
    return () => {
      cancelIndicatorFrame();
    };
  }, [cancelIndicatorFrame]);

  useLayoutEffect(() => {
    positionActiveIndicator();
  }, [positionActiveIndicator]);

  useEffect(() => {
    if (pendingNavKeyRef.current) {
      return;
    }

    visualNavKeyRef.current = currentNavKey;
    setVisualNavKey(currentNavKey);
  }, [currentNavKey]);

  useEffect(() => {
    const handleViewportChange = () => {
      finishFloatingIndicator();
      positionActiveIndicator();
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
          prefetchNavRoute(item.href);
        }
      }
    };
    let timeoutHandle: number | null = null;
    const frameHandle = window.requestAnimationFrame(() => {
      timeoutHandle = window.setTimeout(prefetchPrimaryRoutes, 80);
    });

    return () => {
      window.cancelAnimationFrame(frameHandle);
      if (timeoutHandle !== null) {
        window.clearTimeout(timeoutHandle);
      }
    };
  }, [currentNavKey, prefetchNavRoute]);

  const handleNavPointerDown = useCallback(
    (targetKey: PrimaryNavKey, event: PointerEvent<HTMLAnchorElement>) => {
      if (!isPrimaryUnmodifiedEvent(event) || visualNavKeyRef.current === targetKey) {
        return;
      }

      moveFloatingIndicatorToLink(event.currentTarget);
      moveVisualIndicator(targetKey, event.currentTarget);
    },
    [moveVisualIndicator],
  );

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

      moveFloatingIndicatorToLink(event.currentTarget);
      moveVisualIndicator(targetKey, event.currentTarget);

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
    [currentNavKey, moveVisualIndicator, router],
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
                  onPointerDown={(event) => {
                    prefetchNavRoute(item.href);
                    handleNavPointerDown(item.key, event);
                  }}
                  onPointerEnter={() => prefetchNavRoute(item.href)}
                  prefetch={true}
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
      {pendingConfig ? (
        <div className="routePendingContent" data-route-kind={pendingConfig.kind} aria-live="polite">
          <PrimaryRouteLoadingContent config={pendingConfig} />
        </div>
      ) : null}
    </>
  );
}
