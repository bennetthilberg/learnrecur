import { Skeleton } from "@mantine/core";
import type { ReactNode } from "react";

import type { SkillsTopbarCurrent } from "./skills-topbar";

export type PrimaryRouteKey = Exclude<SkillsTopbarCurrent, "skill">;

type PrimaryRouteLoadingKind =
  | "collections"
  | "dashboard"
  | "history"
  | "new"
  | "practice"
  | "settings"
  | "skills";

export type PrimaryRouteLoadingConfig = {
  detail: string;
  kind: PrimaryRouteLoadingKind;
  title: string;
};

export const primaryRouteLoadingByKey: Record<PrimaryRouteKey, PrimaryRouteLoadingConfig> = {
  collections: {
    detail: "Create, describe, archive, and restore the study areas that organize your skills.",
    kind: "collections",
    title: "Organize practice",
  },
  dashboard: {
    detail: "Loading your due skills and recent practice activity.",
    kind: "dashboard",
    title: "Due skills are ready.",
  },
  history: {
    detail: "A compact record of completed reviews, grading outcomes, and how each answer changed the memory schedule.",
    kind: "history",
    title: "Review ledger",
  },
  new: {
    detail: "Upload, paste, or write source material. LearnRecur will create a skill for review before practice.",
    kind: "new",
    title: "Create a skill",
  },
  practice: {
    detail: "Preparing the next due exercise.",
    kind: "practice",
    title: "Practice",
  },
  settings: {
    detail: "Manage quiet reminders and download a copy of your study data.",
    kind: "settings",
    title: "Reminders and data",
  },
  skills: {
    detail: "Resume draft review, check activation issues, and scan active practice targets.",
    kind: "skills",
    title: "Recover and schedule skills",
  },
};

export function PrimaryRouteLoadingContent({
  config,
}: {
  config: PrimaryRouteLoadingConfig;
}) {
  switch (config.kind) {
    case "dashboard":
      return <DashboardRouteLoading />;
    case "practice":
      return <PracticeRouteLoading config={config} />;
    case "history":
      return <HistoryRouteLoading config={config} />;
    case "skills":
      return <SkillsRouteLoading config={config} />;
    case "new":
      return <NewSkillRouteLoading config={config} />;
    case "collections":
      return <CollectionsRouteLoading config={config} />;
    case "settings":
      return <SettingsRouteLoading config={config} />;
    default:
      throw new Error(`Unexpected route loading kind: ${(config as { kind: string }).kind}`);
  }
}

function RouteHeader({
  actionCount = 0,
  config,
}: {
  actionCount?: number;
  config: PrimaryRouteLoadingConfig;
}) {
  return (
    <header className="skillHeader routeLoadingHeader">
      <div>
        <h1>{config.title}</h1>
        <p>{config.detail}</p>
      </div>
      {actionCount > 0 ? (
        <div className="routeLoadingHeaderActions" aria-hidden="true">
          {Array.from({ length: actionCount }, (_, index) => (
            <Skeleton
              className="routeSkeleton"
              height={42}
              key={index}
              radius={8}
              width={index === 0 ? 118 : 144}
            />
          ))}
        </div>
      ) : null}
    </header>
  );
}

function PanelSkeleton({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title: string;
}) {
  return (
    <section className={`skillPanel routeLoadingPanel ${className ?? ""}`.trim()}>
      <div className="skillPanelHeader">
        <div>
          <h2>{title}</h2>
        </div>
      </div>
      {children}
    </section>
  );
}

function DashboardRouteLoading() {
  return (
    <>
      <section className="openWaterHero dashboardHero routeLoadingHero" aria-label="Dashboard loading">
        <div className="routeLoadingHeroWave" aria-hidden="true" />
        <div className="routeLoadingHeroRings" aria-hidden="true" />
        <div className="openWaterHeroContent">
          <h1 className="disp routeLoadingHeroTitle">
            <Skeleton
              className="routeSkeleton routeLoadingHeroSentence"
              height={42}
              radius={8}
              width="min(560px, 84%)"
            />
          </h1>
          <div className="openWaterHeroActions" aria-hidden="true">
            <Skeleton className="routeSkeleton routeLoadingHeroButton" height={44} radius={8} width={140} />
            <Skeleton className="routeSkeleton routeLoadingHeroButton" height={44} radius={8} width={140} />
          </div>
        </div>
      </section>

      <section className="openWaterStatGrid" aria-label="Practice summary loading">
        {["Due", "New", "Retention"].map((label) => (
          <article className="openWaterStatTile routeLoadingStatTile" key={label}>
            <p>{label}</p>
            <Skeleton className="routeSkeleton" height={31} radius={6} width={label === "Retention" ? 58 : 34} />
          </article>
        ))}
      </section>

      <section className="openWaterSection openWaterReviewSection" aria-labelledby="loading-up-next-title">
        <h2 id="loading-up-next-title" className="disp openWaterSectionTitle">
          Up next
        </h2>
        <article className="openWaterReviewCard routeLoadingReviewCard">
          <div className="openWaterReviewTop" aria-hidden="true">
            <Skeleton className="routeSkeleton" height={15} radius={5} width={116} />
            <Skeleton className="routeSkeleton" height={15} radius={5} width={82} />
          </div>
          <Skeleton className="routeSkeleton" height={15} radius={5} width="38%" />
          <Skeleton className="routeSkeleton routeLoadingReviewPrompt" height={34} radius={7} width="82%" />
          <Skeleton className="routeSkeleton" height={14} radius={5} width="68%" />
          <div className="openWaterReviewActions" aria-hidden="true">
            <Skeleton className="routeSkeleton routeLoadingActionButton" height={44} radius={8} width={138} />
            <Skeleton className="routeSkeleton routeLoadingActionButton" height={44} radius={8} width={132} />
          </div>
        </article>
      </section>

      <section className="openWaterSection openWaterCollections" aria-labelledby="loading-collections-title">
        <div className="openWaterSectionHeader">
          <h2 id="loading-collections-title" className="disp openWaterSectionTitle">
            Collections
          </h2>
          <Skeleton className="routeSkeleton routeLoadingActionButton" height={39} radius={8} width={118} />
        </div>
        <div className="openWaterDeckList">
          <DashboardDeckRowSkeleton />
        </div>
      </section>
    </>
  );
}

function DashboardDeckRowSkeleton() {
  return (
    <article className="openWaterDeckRow routeLoadingDeckRow" aria-hidden="true">
      <Skeleton className="routeSkeleton" height={32} radius={8} width={32} />
      <div className="routeLoadingDeckText">
        <Skeleton className="routeSkeleton" height={15} radius={5} width={190} />
        <Skeleton className="routeSkeleton" height={12} radius={5} width={132} />
      </div>
      <Skeleton className="routeSkeleton" height={24} radius={6} width={92} />
    </article>
  );
}

function PracticeRouteLoading({ config }: { config: PrimaryRouteLoadingConfig }) {
  return (
    <>
      <section className="practiceScopeBar routeLoadingScope" aria-label="Practice scope loading">
        <Skeleton className="routeSkeleton" height={14} radius={5} width={132} />
        <Skeleton className="routeSkeleton" height={14} radius={5} width={96} />
      </section>
      <section className="practiceFrame routeLoadingPracticeFrame" aria-label={`${config.title} loading`}>
        <div className="practiceMetaRow">
          <div>
            <h1>{config.title}</h1>
          </div>
          <div className="routeLoadingPracticeFacts" aria-hidden="true">
            <Skeleton className="routeSkeleton" height={36} radius={6} width={108} />
            <Skeleton className="routeSkeleton" height={36} radius={6} width={82} />
          </div>
        </div>

        <article className="practicePromptPanel">
          <Skeleton className="routeSkeleton" height={17} radius={5} width={84} />
          <Skeleton className="routeSkeleton routeLoadingPracticePrompt" height={33} radius={7} width="78%" />
        </article>

        <div className="choiceGrid" aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton className="routeSkeleton routeLoadingChoice" height={58} key={index} radius={8} />
          ))}
        </div>
        <div className="practiceActions" aria-hidden="true">
          <Skeleton className="routeSkeleton routeLoadingActionButton" height={42} radius={8} width={112} />
        </div>
      </section>
    </>
  );
}

function SkillsRouteLoading({ config }: { config: PrimaryRouteLoadingConfig }) {
  return (
    <>
      <RouteHeader actionCount={1} config={config} />
      <div className="skillLibraryGrid">
        <PanelSkeleton title="Draft skills">
          <div className="skillLibraryList">
            <SkillLibraryRowSkeleton />
            <SkillLibraryRowSkeleton compact />
          </div>
        </PanelSkeleton>
        <PanelSkeleton title="Practice targets">
          <div className="skillLibraryList">
            <SkillLibraryRowSkeleton withFacts />
            <SkillLibraryRowSkeleton compact withFacts />
          </div>
        </PanelSkeleton>
      </div>
    </>
  );
}

function SkillLibraryRowSkeleton({
  compact = false,
  withFacts = false,
}: {
  compact?: boolean;
  withFacts?: boolean;
}) {
  return (
    <article className="skillLibraryRow routeLoadingLibraryRow" aria-hidden="true">
      <div className="skillLibraryRowMain">
        <div className="routeLoadingLibraryCopy">
          <Skeleton className="routeSkeleton" height={18} radius={5} width={compact ? "54%" : "72%"} />
          <Skeleton className="routeSkeleton" height={13} radius={5} width={compact ? "64%" : "86%"} />
        </div>
        <Skeleton className="routeSkeleton" height={25} radius={6} width={62} />
      </div>
      <div className="routeLoadingMetaLine">
        <Skeleton className="routeSkeleton" height={12} radius={5} width={88} />
        <Skeleton className="routeSkeleton" height={12} radius={5} width={72} />
        <Skeleton className="routeSkeleton" height={12} radius={5} width={98} />
      </div>
      {withFacts ? (
        <div className="routeLoadingFactsGrid">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton className="routeSkeleton" height={43} key={index} radius={6} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function NewSkillRouteLoading({ config }: { config: PrimaryRouteLoadingConfig }) {
  return (
    <>
      <RouteHeader config={config} />
      <div className="skillCreateStack routeLoadingCreateStack">
        <nav className="skillCreationTabs routeLoadingTabs" aria-label="Skill creation mode">
          <span aria-current="page">From source</span>
          <span>Manual</span>
        </nav>
        <section className="skillCreationPath" aria-label="Source-backed skill creation path">
          <div>
            <span>Input</span>
            <strong>Add source material.</strong>
          </div>
          <div>
            <span>Create</span>
            <strong>Wait while LearnRecur writes the skill.</strong>
          </div>
          <div>
            <span>Add</span>
            <strong>Review, edit, then add it to practice.</strong>
          </div>
        </section>
        <section className="skillSourceEntryGrid" aria-label="Source-backed skill options loading">
          <PanelSkeleton title="Upload material">
            <div className="routeLoadingDropzone" aria-hidden="true">
              <Skeleton className="routeSkeleton" height={44} radius={8} width={154} />
              <Skeleton className="routeSkeleton" height={14} radius={5} width="58%" />
              <Skeleton className="routeSkeleton" height={12} radius={5} width="42%" />
            </div>
          </PanelSkeleton>
          <PanelSkeleton title="Paste material">
            <div className="routeLoadingFormStack" aria-hidden="true">
              <Skeleton className="routeSkeleton" height={116} radius={8} />
              <Skeleton className="routeSkeleton" height={40} radius={8} />
              <Skeleton className="routeSkeleton routeLoadingActionButton" height={42} radius={8} width={142} />
            </div>
          </PanelSkeleton>
        </section>
      </div>
    </>
  );
}

function HistoryRouteLoading({ config }: { config: PrimaryRouteLoadingConfig }) {
  return (
    <>
      <RouteHeader actionCount={2} config={config} />
      <section className="skillPanel historyPanel routeLoadingPanel" aria-label="Review history loading">
        <div className="skillPanelHeader">
          <div>
            <h2>Latest completed reviews</h2>
          </div>
        </div>
        <div className="historyTableWrapper">
          <table className="historyTable routeLoadingHistoryTable">
            <thead>
              <tr>
                <th scope="col">Reviewed</th>
                <th scope="col">Skill</th>
                <th scope="col">Result</th>
                <th scope="col">Rating</th>
                <th scope="col">Next due</th>
              </tr>
            </thead>
            <tbody aria-hidden="true">
              {Array.from({ length: 3 }, (_, index) => (
                <HistoryRowSkeleton key={index} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function HistoryRowSkeleton() {
  return (
    <tr>
      <td>
        <Skeleton className="routeSkeleton" height={18} radius={5} width={72} />
        <Skeleton className="routeSkeleton" height={13} radius={5} mt={10} width={62} />
      </td>
      <td>
        <Skeleton className="routeSkeleton" height={18} radius={5} width="76%" />
        <Skeleton className="routeSkeleton" height={13} radius={5} mt={12} width="48%" />
      </td>
      <td>
        <Skeleton className="routeSkeleton" height={36} radius={8} width={96} />
        <Skeleton className="routeSkeleton" height={13} radius={5} mt={14} width={150} />
      </td>
      <td>
        <Skeleton className="routeSkeleton" height={18} radius={5} width={58} />
        <Skeleton className="routeSkeleton" height={13} radius={5} mt={12} width={132} />
      </td>
      <td>
        <Skeleton className="routeSkeleton" height={18} radius={5} width={94} />
        <Skeleton className="routeSkeleton" height={13} radius={5} mt={12} width={122} />
      </td>
    </tr>
  );
}

function CollectionsRouteLoading({ config }: { config: PrimaryRouteLoadingConfig }) {
  return (
    <>
      <RouteHeader actionCount={1} config={config} />
      <PanelSkeleton className="collectionCreatePanel" title="Add a study area">
        <div className="routeLoadingFormStack" aria-hidden="true">
          <Skeleton className="routeSkeleton" height={42} radius={8} />
          <Skeleton className="routeSkeleton" height={82} radius={8} />
          <Skeleton className="routeSkeleton routeLoadingActionButton" height={42} radius={8} width={148} />
        </div>
      </PanelSkeleton>
      <PanelSkeleton className="collectionManagementPanel" title="Current collections">
        <article className="routeLoadingCollectionRow" aria-hidden="true">
          <div>
            <Skeleton className="routeSkeleton" height={20} radius={5} width={190} />
            <Skeleton className="routeSkeleton" height={14} radius={5} mt={13} width="62%" />
            <div className="routeLoadingMetaLine">
              <Skeleton className="routeSkeleton" height={13} radius={5} width={92} />
              <Skeleton className="routeSkeleton" height={13} radius={5} width={84} />
              <Skeleton className="routeSkeleton" height={13} radius={5} width={110} />
            </div>
            <div className="routeLoadingCollectionActions">
              <Skeleton className="routeSkeleton" height={40} radius={8} width={82} />
              <Skeleton className="routeSkeleton" height={40} radius={8} width={68} />
              <Skeleton className="routeSkeleton" height={44} radius={8} width={128} />
            </div>
          </div>
          <Skeleton className="routeSkeleton" height={72} radius={8} width={124} />
        </article>
      </PanelSkeleton>
    </>
  );
}

function SettingsRouteLoading({ config }: { config: PrimaryRouteLoadingConfig }) {
  return (
    <>
      <RouteHeader actionCount={1} config={config} />
      <PanelSkeleton className="settingsPanel" title="Due-practice email">
        <div className="routeLoadingSettingsSummary" aria-hidden="true">
          <Skeleton className="routeSkeleton" height={48} radius={8} />
          <Skeleton className="routeSkeleton" height={48} radius={8} />
          <Skeleton className="routeSkeleton" height={48} radius={8} />
        </div>
        <div className="routeLoadingSettingsForm" aria-hidden="true">
          <div>
            <Skeleton className="routeSkeleton" height={36} radius={6} width="62%" />
            <Skeleton className="routeSkeleton" height={58} radius={8} mt={18} />
          </div>
          <div>
            <div className="routeLoadingTwoColumn">
              <Skeleton className="routeSkeleton" height={58} radius={8} />
              <Skeleton className="routeSkeleton" height={58} radius={8} />
            </div>
            <Skeleton className="routeSkeleton" height={58} radius={8} mt={18} />
            <Skeleton className="routeSkeleton routeLoadingActionButton" height={44} radius={8} mt={22} width={160} />
          </div>
        </div>
        <div className="settingsPrivacyNote routeLoadingPrivacyNote" aria-hidden="true">
          <section>
            <h3>Email includes</h3>
            <Skeleton className="routeSkeleton" height={15} radius={5} width="68%" />
          </section>
          <section>
            <h3>Kept out</h3>
            <Skeleton className="routeSkeleton" height={15} radius={5} width="82%" />
          </section>
        </div>
      </PanelSkeleton>
      <PanelSkeleton className="settingsExportPanel" title="Download study data">
        <div className="routeLoadingFactsGrid" aria-hidden="true">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton className="routeSkeleton" height={48} key={index} radius={6} />
          ))}
        </div>
        <Skeleton className="routeSkeleton" height={70} radius={8} />
      </PanelSkeleton>
    </>
  );
}
