"use client";

import { useEffect } from "react";

const skeletonSelector = ".routeSkeleton, .practiceAttentionSkeleton";
const shellSelector = "main.dashboardShell, main.practiceShell, main.skillShell";
// Fast loads should appear immediately, without adding a visual wait.
const minimumLoadingDuration = 200;
const duration = 240;
const easing = "cubic-bezier(0.22, 1, 0.36, 1)";

type Shape = { x: number; y: number; width: number; height: number; radius: string; color: string };

/** Route fallbacks, optimistic navigation, and practice loaders share one handoff.
 * Observe their rendered skeletons because server-streamed fallbacks and client
 * loaders do not share a React lifetime. No content is held back or remounted.
 */
export function SkeletonReveal() {
  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let shapes: Shape[] = [];
    let loadingStartedAt: number | null = null;
    let frame = 0;
    let overlay: HTMLDivElement | null = null;
    const animations = new Set<Animation>();

    const cancel = () => {
      for (const animation of animations) animation.cancel();
      animations.clear();
      overlay?.remove();
      overlay = null;
    };
    const animate = (element: HTMLElement, keyframes: Keyframe[]) => {
      const animation = element.animate(keyframes, { duration, easing });
      animations.add(animation);
      void animation.finished.then(() => animations.delete(animation), () => animations.delete(animation));
      return animation;
    };
    const scan = () => {
      frame = 0;
      const shells = Array.from(document.querySelectorAll<HTMLElement>(shellSelector))
        .filter((shell) => shell.getClientRects().length > 0);
      // Static destinations should not inherit a reveal from an interrupted load.
      if (shells.some((shell) => Array.from(shell.querySelectorAll('[data-skeleton-reveal="skip"]'))
        .some((node) => node.getClientRects().length > 0))) {
        shapes = [];
        loadingStartedAt = null;
        cancel();
        return;
      }
      const skeletons = shells.flatMap((shell) => Array.from(shell.querySelectorAll<HTMLElement>(skeletonSelector)))
        .filter((node) => node.getClientRects().length > 0);
      if (skeletons.length) {
        cancel();
        // Keep only visible placeholder geometry, never a copy of learner content.
        shapes = motion.matches ? [] : skeletons.flatMap((node) => {
          const rect = node.getBoundingClientRect();
          if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight) return [];
          const style = getComputedStyle(node);
          return [{ x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width,
            height: rect.height, radius: style.borderRadius, color: style.backgroundColor }];
        });
        loadingStartedAt = shapes.length ? (loadingStartedAt ?? performance.now()) : null;
        return;
      }
      const wasLoadingLongEnough = loadingStartedAt !== null &&
        performance.now() - loadingStartedAt >= minimumLoadingDuration;
      loadingStartedAt = null;
      const previous = shapes;
      shapes = [];
      if (!wasLoadingLongEnough || !previous.length || motion.matches || !shells.length) return;
      cancel();
      const layer = document.createElement("div");
      layer.className = "skeletonRevealOverlay";
      layer.setAttribute("aria-hidden", "true");
      layer.inert = true;
      for (const shape of previous) {
        const block = document.createElement("span");
        Object.assign(block.style, { position: "absolute", left: `${shape.x}px`, top: `${shape.y}px`,
          width: `${shape.width}px`, height: `${shape.height}px`, borderRadius: shape.radius,
          backgroundColor: shape.color });
        layer.append(block);
      }
      document.body.append(layer);
      overlay = layer;
      const fade = animate(layer, [{ opacity: 1, filter: "blur(0px)" }, { opacity: 0, filter: "blur(4px)" }]);
      void fade.finished.then(() => { layer.remove(); if (overlay === layer) overlay = null; }, () => layer.remove());
      for (const shell of shells) {
        for (const child of Array.from(shell.children)) {
          if (!(child instanceof HTMLElement) || child.matches(".practiceTopbar, .openWaterBackground, script, style") || !child.getClientRects().length) continue;
          animate(child, [{ opacity: 0, filter: "blur(4px)" }, { opacity: 1, filter: "blur(0px)" }]);
        }
      }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(scan); };
    // Attribute changes matter when an optimistic skeleton hides the old page.
    const observer = new MutationObserver((records) => {
      if (records.some((record) => {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        return target?.closest(shellSelector) || Array.from(record.addedNodes).some((node) =>
          node instanceof Element && (node.matches(shellSelector) || node.querySelector(shellSelector)));
      })) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["hidden", "data-route-pending"] });
    const reset = () => { shapes = []; loadingStartedAt = null; cancel(); schedule(); };
    // A viewport change invalidates the outgoing placeholder coordinates.
    window.addEventListener("resize", reset);
    window.addEventListener("scroll", reset, true);
    motion.addEventListener("change", reset);
    schedule();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      cancel();
      window.removeEventListener("resize", reset);
      window.removeEventListener("scroll", reset, true);
      motion.removeEventListener("change", reset);
    };
  }, []);
  return null;
}
