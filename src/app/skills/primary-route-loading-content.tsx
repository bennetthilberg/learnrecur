import type { SkillsTopbarCurrent } from "./skills-topbar";

export type PrimaryRouteKey = Exclude<SkillsTopbarCurrent, "skill">;

export type PrimaryRouteLoadingConfig = {
  detail: string;
  eyebrow: string;
  title: string;
};

export const primaryRouteLoadingByKey: Record<PrimaryRouteKey, PrimaryRouteLoadingConfig> = {
  collections: {
    detail: "Loading study areas and ready counts.",
    eyebrow: "Study areas",
    title: "Opening collections",
  },
  dashboard: {
    detail: "Loading your due skills and recent practice activity.",
    eyebrow: "Dashboard",
    title: "Opening dashboard",
  },
  history: {
    detail: "Loading completed reviews and schedule changes.",
    eyebrow: "History",
    title: "Opening review ledger",
  },
  new: {
    detail: "Preparing the skill creation workspace.",
    eyebrow: "New skill",
    title: "Opening skill drafts",
  },
  practice: {
    detail: "Preparing the next due exercise.",
    eyebrow: "Practice",
    title: "Opening practice",
  },
  settings: {
    detail: "Loading reminder preferences and data controls.",
    eyebrow: "Account controls",
    title: "Opening settings",
  },
  skills: {
    detail: "Loading active skills, drafts, and recovery items.",
    eyebrow: "Library",
    title: "Opening skills",
  },
};

export function PrimaryRouteLoadingContent({
  config,
}: {
  config: PrimaryRouteLoadingConfig;
}) {
  return (
    <>
      <header className="skillHeader routeLoadingHeader">
        <div>
          <p className="eyebrow">{config.eyebrow}</p>
          <h1>{config.title}</h1>
          <p>{config.detail}</p>
        </div>
      </header>
      <section className="skillPanel routeLoadingPanel" aria-label={`${config.title} loading`}>
        <div className="routeLoadingLine" data-width="wide" />
        <div className="routeLoadingLine" data-width="medium" />
        <div className="routeLoadingRows" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </section>
    </>
  );
}
