import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("../../src/app/open-water.css", import.meta.url),
  "utf8",
);

describe("skills path loading styles", () => {
  it("uses an opt-in shimmer instead of animating every skeleton in the app", () => {
    expect(styles).toContain(".routeSkeleton.routeSkeletonShimmer::after");
    expect(styles).toContain("animation: route-skeleton-shimmer");
    expect(styles).toContain("@keyframes route-skeleton-shimmer");
  });

  it("stops the shimmer when reduced motion is requested", () => {
    const reducedMotionStyles = styles.slice(
      styles.lastIndexOf("@media (prefers-reduced-motion: reduce)"),
    );

    expect(reducedMotionStyles).toContain(".routeSkeleton.routeSkeletonShimmer::after");
    expect(reducedMotionStyles).toContain("animation: none !important");
  });

  it("styles the route-specific rows and panels without introducing fake controls", () => {
    expect(styles).toContain(".skillsPathOutlineRow");
    expect(styles).toContain(".skillsPathSideRow");
    expect(styles).toContain(".skillsPathCorrectionLoading");
    expect(styles).toContain(".skillsPathGuidanceLoading");
  });
});
