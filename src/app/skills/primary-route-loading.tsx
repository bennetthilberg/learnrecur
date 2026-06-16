import { SkillsTopbar, type SkillsTopbarCurrent } from "./skills-topbar";
import { PrimaryRouteLoadingContent, type PrimaryRouteLoadingConfig } from "./primary-route-loading-content";

type PrimaryRouteLoadingProps = {
  current: Exclude<SkillsTopbarCurrent, "skill">;
  config: PrimaryRouteLoadingConfig;
  variant?: "dashboard" | "practice" | "standard";
};

export function PrimaryRouteLoading({
  current,
  config,
  variant = "standard",
}: PrimaryRouteLoadingProps) {
  const shellClassName =
    variant === "dashboard"
      ? "dashboardShell"
      : variant === "practice"
        ? "practiceShell"
        : "skillShell";

  return (
    <main className={shellClassName} aria-busy="true">
      <SkillsTopbar current={current} />
      <PrimaryRouteLoadingContent config={config} />
    </main>
  );
}
