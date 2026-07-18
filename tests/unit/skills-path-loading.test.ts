import { readFileSync } from "node:fs";

import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/app/skills/skills-topbar", () => ({
  SkillsTopbar: ({ current }: { current: string }) =>
    createElement("nav", { "data-current": current }, "LearnRecur"),
}));

import {
  SkillsPathLoading,
  type SkillsPathLoadingKind,
} from "../../src/app/skills/skills-path-loading";

const routeCases: Array<{
  current: string;
  kind: SkillsPathLoadingKind;
  marker: string;
}> = [
  { current: "skills", kind: "skills-library", marker: "Manage the skills in your practice schedule." },
  { current: "new", kind: "new-choice", marker: "What are you adding?" },
  { current: "new", kind: "new-one", marker: "Add learning material" },
  { current: "new", kind: "new-multiple", marker: "Reuse a material" },
  { current: "skills", kind: "materials-library", marker: "Your references" },
  { current: "skills", kind: "material-detail", marker: "About this material" },
  { current: "new", kind: "material-describe", marker: "What should this book become?" },
  { current: "new", kind: "material-batch", marker: "Change the request" },
  { current: "skill", kind: "skill-detail", marker: "Practice guidance" },
];

describe("SkillsPathLoading", () => {
  it.each(routeCases)("renders a page-shaped $kind loading state", ({ current, kind, marker }) => {
    const markup = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(SkillsPathLoading, { kind }),
      ),
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain(`data-loading-route="${kind}"`);
    expect(markup).toContain(`data-current="${current}"`);
    expect(markup).toContain("routeSkeletonShimmer");
    expect(markup).toContain(marker);
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<a ");
    expect(markup).not.toContain("<form");
  });

  it("places a dedicated loading boundary at every skills path shape", () => {
    const loadingRoutes = [
      ["../../src/app/skills/loading.tsx", "skills-library"],
      ["../../src/app/skills/new/loading.tsx", "new-choice"],
      ["../../src/app/skills/new/one/loading.tsx", "new-one"],
      ["../../src/app/skills/new/multiple/loading.tsx", "new-multiple"],
      ["../../src/app/skills/materials/loading.tsx", "materials-library"],
      ["../../src/app/skills/materials/[materialId]/loading.tsx", "material-detail"],
      ["../../src/app/skills/materials/[materialId]/create/loading.tsx", "material-describe"],
      ["../../src/app/skills/batches/[batchId]/loading.tsx", "material-batch"],
      ["../../src/app/skills/[skillId]/loading.tsx", "skill-detail"],
    ] as const;

    for (const [path, kind] of loadingRoutes) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");

      expect(source).toContain("SkillsPathLoading");
      expect(source).toContain(`kind="${kind}"`);
    }
  });

  it("keeps the Skills library skeleton aligned with its compact loaded rows", () => {
    const markup = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(SkillsPathLoading, { kind: "skills-library" }),
      ),
    );

    expect(markup).toContain("skillLibraryRowControls");
    expect(markup).not.toContain("routeLoadingFactsGrid");
  });

  it("uses the choice-card skeleton during immediate Add navigation", () => {
    const source = readFileSync(
      new URL("../../src/app/skills/primary-route-loading-content.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('title: "What are you adding?"');
    expect(source).toContain('className="createModeChoices skillsPathChoiceLoading"');
  });
});
