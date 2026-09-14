import { Skeleton } from "@mantine/core";
import type { ReactNode } from "react";
import { OpenWaterHeroRings, OpenWaterHeroWaves } from "@/components/app/open-water";

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
    detail: "See recent review results, ratings, next due dates, and the details behind each answer.",
    kind: "history",
    title: "History",
  },
  new: {
    detail: "Use the fast path for one target, or a reusable material for a chapter-sized batch.",
    kind: "new",
    title: "What are you adding?",
  },
  practice: {
    detail: "Preparing the next due exercise.",
    kind: "practice",
    title: "Practice",
  },
  settings: {
    detail: "Email reminders and study data export.",
    kind: "settings",
    title: "Settings",
  },
  skills: {
    detail: "Manage the skills in your practice schedule.",
    kind: "skills",
    title: "Skills",
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
  shimmer = false,
}: {
  actionCount?: number;
  config: PrimaryRouteLoadingConfig;
  shimmer?: boolean;
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
            <Skeleton component="span"
              className={`routeSkeleton${shimmer ? " routeSkeletonShimmer" : ""}`}
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
      <section className="openWaterHero dashboardHero routeLoadingHero" aria-label="Dashboard loading" aria-busy="true">
        <OpenWaterHeroWaves />
        <OpenWaterHeroRings />
        <div className="openWaterHeroContent">
          <h1 className="disp"><Skeleton component="span" className="routeSkeleton" height="1.18em" width="min(560px, 84%)" /></h1>
          <div className="openWaterHeroActions" aria-hidden="true">
            <Skeleton component="span" className="routeSkeleton" height={38} width={114} />
            <Skeleton component="span" className="routeSkeleton" height={38} width={126} />
          </div>
        </div>
      </section>
      <section className="openWaterStatGrid" aria-label="Practice summary loading">
        {["Due", "Active", "Retention"].map((label) => (
          <article className="openWaterStatTile" key={label}>
            <p>{label}</p>
            <strong className="disp"><Skeleton component="span" className="routeSkeleton" height="1em" width={label === "Retention" ? 58 : 34} /></strong>
          </article>
        ))}
      </section>
      <section className="openWaterSection openWaterReviewSection" aria-label="Up next loading">
        <h2 className="disp openWaterSectionTitle">Up next</h2>
        <article className="openWaterReviewCard" aria-hidden="true">
          <div className="openWaterReviewTop">
            <Skeleton component="span" className="routeSkeleton" height="1.4em" width={60} />
            <Skeleton component="span" className="routeSkeleton" height="1.4em" width={82} />
          </div>
          <p className="disp openWaterReviewPrompt">
            <Skeleton component="span" className="routeSkeleton" height="1.35em" width="95%" />
            <Skeleton component="span" className="routeSkeleton dashboardLoadingMobileLine" height="1.35em" width="85%" />
            <Skeleton component="span" className="routeSkeleton dashboardLoadingMobileLine" height="1.35em" width="62%" />
          </p>
          <p className="openWaterReviewNote"><Skeleton component="span" className="routeSkeleton" height="1.45em" width="68%" /></p>
          <div className="openWaterReviewActions">
            <Skeleton component="span" className="routeSkeleton" height={36} width={106} />
            <Skeleton component="span" className="routeSkeleton" height={36} width={110} />
          </div>
        </article>
      </section>
      <section className="openWaterSection openWaterCollections" aria-label="Collections loading">
        <div className="openWaterSectionHeader">
          <h2 className="disp openWaterSectionTitle">Collections</h2>
          <Skeleton component="span" className="routeSkeleton" height={34} width={90} />
        </div>
        <div className="openWaterDeckList"><DashboardDeckRowSkeleton /></div>
      </section>
    </>
  );
}

function DashboardDeckRowSkeleton() {
  return (
    <article className="openWaterDeckRow routeLoadingDeckRow" aria-hidden="true">
      <Skeleton component="span" className="routeSkeleton" height={32} radius={8} width={32} />
      <div className="routeLoadingDeckText">
        <Skeleton component="span" className="routeSkeleton" height={15} radius={5} width={190} />
        <Skeleton component="span" className="routeSkeleton" height={12} radius={5} width={132} />
      </div>
      <Skeleton component="span" className="routeSkeleton" height={24} radius={6} width={92} />
    </article>
  );
}

export function PracticeRouteLoading({
  config = primaryRouteLoadingByKey.practice,
  custom = false,
}: { config?: PrimaryRouteLoadingConfig; custom?: boolean }) {
  return (
    <>
      {custom ? (
        <div className="practiceScopeBar customPracticeScopeBar" aria-hidden="true">
          <Skeleton component="span" className="routeSkeleton" height={24} width={110} />
          <Skeleton component="span" className="routeSkeleton" height={24} width={110} />
          <Skeleton component="span" className="routeSkeleton" height={24} width={60} />
          <Skeleton component="span" className="routeSkeleton" height={44} width={110} />
        </div>
      ) : (
        <div className="practiceToolbar" aria-hidden="true">
          <div className="practiceScopeBar">
            <div className="practiceScopeIdentity"><Skeleton component="span" className="routeSkeleton" height={32} width={92} /></div>
            <div className="practiceScopeLinks"><Skeleton component="span" className="routeSkeleton" height={20} width={102} /><Skeleton component="span" className="routeSkeleton" height={20} width={111} /></div>
          </div>
        </div>
      )}
      <section className="practiceFrame routeLoadingPracticeFrame" aria-label={`${config.title} loading`} aria-busy="true">
        <div className="practiceMetaRow" aria-hidden="true">
          <div className="practiceLoadingMeta">
            <p className="practiceMetaSummary"><Skeleton component="span" className="routeSkeleton" height="1lh" width={68} /></p>
          </div>
        </div>
        <article className="practicePromptPanel" aria-hidden="true">
          <p><Skeleton component="span" className="routeSkeleton" height="1lh" width="95%" /><Skeleton component="span" className="routeSkeleton" height="1lh" width="62%" /></p>
        </article>
        <div className="practiceLoadingAnswers" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <div className="practiceLoadingAnswer" key={index}>
              <Skeleton component="span" className="routeSkeleton" height={30} width={30} />
              <Skeleton component="span" className="routeSkeleton" height={20} width={`${28 + index * 11}%`} />
            </div>
          ))}
        </div>
        <div className="practiceActions" aria-hidden="true"><Skeleton component="span" className="routeSkeleton" height={48} width={136} /></div>
      </section>
    </>
  );
}

function SkillsRouteLoading({ config }: { config: PrimaryRouteLoadingConfig }) {
  return (
    <>
      <RouteHeader actionCount={2} config={config} shimmer />
      <div className="skillLibraryGrid" data-layout="single">
        <PanelSkeleton title="Skills">
          <div className="skillLibraryList">
            <SkillLibraryRowSkeleton />
            <SkillLibraryRowSkeleton compact />
          </div>
        </PanelSkeleton>
      </div>
    </>
  );
}

function SkillLibraryRowSkeleton({
  compact = false,
}: {
  compact?: boolean;
}) {
  return (
    <article className="skillLibraryRow routeLoadingLibraryRow" aria-hidden="true">
      <div className="skillLibraryRowMain">
        <div className="routeLoadingLibraryCopy">
          <Skeleton component="span" className="routeSkeleton routeSkeletonShimmer" height={18} radius={5} width={compact ? "54%" : "72%"} />
          <Skeleton component="span" className="routeSkeleton routeSkeletonShimmer" height={13} radius={5} width={compact ? "64%" : "86%"} />
        </div>
        <div className="skillLibraryRowControls">
          <Skeleton component="span" className="routeSkeleton routeSkeletonShimmer" height={25} radius={6} width={62} />
          <Skeleton component="span" className="routeSkeleton routeSkeletonShimmer" height={34} radius={8} width={34} />
        </div>
      </div>
      <div className="routeLoadingMetaLine">
        <Skeleton component="span" className="routeSkeleton routeSkeletonShimmer" height={12} radius={5} width={88} />
        <Skeleton component="span" className="routeSkeleton routeSkeletonShimmer" height={12} radius={5} width={72} />
      </div>
    </article>
  );
}

function NewSkillRouteLoading({ config }: { config: PrimaryRouteLoadingConfig }) {
  return (
    <>
      <header className="skillHeader createModeHeader routeLoadingHeader">
        <div>
          <h1>{config.title}</h1>
          <p>{config.detail}</p>
        </div>
      </header>
      <div className="createModeChoices skillsPathChoiceLoading" aria-hidden="true">
        {["One skill", "Multiple skills"].map((label, index) => (
          <article className="createModeChoice" key={label}>
            <Skeleton component="span" className="routeSkeleton routeSkeletonShimmer" circle height={40} width={40} />
            <span>
              <strong>{label}</strong>
              <Skeleton component="span" className="routeSkeleton routeSkeletonShimmer" height={13} mt={10} radius={5} width={index === 0 ? "84%" : "92%"} />
              <Skeleton component="span" className="routeSkeleton routeSkeletonShimmer" height={13} mt={8} radius={5} width={index === 0 ? "66%" : "74%"} />
            </span>
            <Skeleton component="span" className="routeSkeleton routeSkeletonShimmer createModeChoiceCue" height={12} radius={5} width={72} />
          </article>
        ))}
      </div>
    </>
  );
}

function HistoryRouteLoading({ config }: { config: PrimaryRouteLoadingConfig }) {
  return (
    <>
      <header className="skillHeader historyHeader">
        <div>
          <h1 aria-label={config.title}>
            <Skeleton component="span"
              aria-hidden="true"
              className="routeSkeleton routeLoadingHistoryTitle"
              height={38}
              radius={7}
              width={126}
            />
          </h1>
          <div className="routeLoadingHistoryHeaderCopy" aria-hidden="true">
            <Skeleton component="span" className="routeSkeleton" height={16} radius={5} width="min(100%, 540px)" />
            <Skeleton component="span" className="routeSkeleton" height={16} radius={5} width="min(100%, 430px)" />
          </div>
        </div>
      </header>

      <div className="historyFilters" aria-hidden="true">
        {[0, 1].map(key => <div key={key}>
          <Skeleton className="routeSkeleton routeSkeletonShimmer" height={20} width={80} mb={6} />
          <Skeleton className="routeSkeleton routeSkeletonShimmer" height={44} />
        </div>)}
        <Skeleton className="routeSkeleton routeSkeletonShimmer" height={24} width={200} />
        <div className="historyFilterActions"><Skeleton className="routeSkeleton routeSkeletonShimmer" height={44} width={220} /></div>
      </div>
      <section
        className="skillPanel historyPanel routeLoadingHistoryPanel"
        aria-label="Review history loading"
      >
        <div className="historyPanelIntro">
          <h2 aria-label="Completed reviews">
            <Skeleton component="span"
              aria-hidden="true"
              className="routeSkeleton routeLoadingHistorySectionTitle"
              height={28}
              radius={6}
              width={230}
            />
          </h2>
          <Skeleton component="span" className="routeSkeleton" height={20} radius={5} width={190} />
        </div>
        <div className="historySimpleTableWrap">
          <table className="historySimpleTable routeLoadingHistoryTable">
            <thead>
              <tr>
                <th scope="col">Reviewed</th>
                <th scope="col">Skill</th>
                <th scope="col">Result</th>
                <th scope="col">Rating</th>
                <th scope="col">Next due</th>
                <th scope="col" aria-label="Review details" />
              </tr>
            </thead>
            <tbody aria-hidden="true">
              {Array.from({ length: 6 }, (_, index) => (
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
      <td data-label="Reviewed">
        <Skeleton component="span" className="routeSkeleton" height={18} radius={5} width={72} />
        <Skeleton component="span" className="routeSkeleton" height={13} radius={5} mt={10} width={62} />
      </td>
      <td data-label="Skill">
        <Skeleton component="span" className="routeSkeleton" height={18} radius={5} width="76%" />
        <Skeleton component="span" className="routeSkeleton" height={13} radius={5} mt={12} width="48%" />
      </td>
      <td data-label="Result">
        <Skeleton component="span" className="routeSkeleton" height={24} radius={6} width={76} />
      </td>
      <td data-label="Rating">
        <Skeleton component="span" className="routeSkeleton" height={18} radius={5} width={58} />
      </td>
      <td data-label="Next due">
        <Skeleton component="span" className="routeSkeleton" height={18} radius={5} width={94} />
      </td>
      <td data-label="Details">
        <Skeleton component="span" className="routeSkeleton" height={34} radius={8} width={70} />
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
          <Skeleton component="span" className="routeSkeleton" height={42} radius={8} />
          <Skeleton component="span" className="routeSkeleton" height={82} radius={8} />
          <Skeleton component="span" className="routeSkeleton routeLoadingActionButton" height={42} radius={8} width={148} />
        </div>
      </PanelSkeleton>
      <PanelSkeleton className="collectionManagementPanel" title="Current collections">
        <article className="routeLoadingCollectionRow" aria-hidden="true">
          <div>
            <Skeleton component="span" className="routeSkeleton" height={20} radius={5} width={190} />
            <Skeleton component="span" className="routeSkeleton" height={14} radius={5} mt={13} width="62%" />
            <div className="routeLoadingMetaLine">
              <Skeleton component="span" className="routeSkeleton" height={13} radius={5} width={92} />
              <Skeleton component="span" className="routeSkeleton" height={13} radius={5} width={84} />
              <Skeleton component="span" className="routeSkeleton" height={13} radius={5} width={110} />
            </div>
            <div className="routeLoadingCollectionActions">
              <Skeleton component="span" className="routeSkeleton" height={40} radius={8} width={82} />
              <Skeleton component="span" className="routeSkeleton" height={40} radius={8} width={68} />
              <Skeleton component="span" className="routeSkeleton" height={44} radius={8} width={128} />
            </div>
          </div>
          <Skeleton component="span" className="routeSkeleton" height={72} radius={8} width={124} />
        </article>
      </PanelSkeleton>
    </>
  );
}

function SettingsRouteLoading({ config }: { config: PrimaryRouteLoadingConfig }) {
  return (
    <>
      <header className="skillHeader settingsHeader">
        <h1>{config.title}</h1>
      </header>

      <section className="skillPanel settingsPanel" aria-label="Practice preferences loading">
        <div className="settingsSectionIntro"><h2>Practice preferences</h2></div>
        <div className="settingsPreferencesBody practicePreferencesLoading" aria-hidden="true">
          <div><Skeleton component="span" className="routeSkeleton" height={18} width={150} /><Skeleton component="span" className="routeSkeleton" height={48} mt={12} /></div>
          <div><Skeleton component="span" className="routeSkeleton" height={24} width={170} /><Skeleton component="span" className="routeSkeleton" height={48} mt={18} /></div>
          <Skeleton component="span" className="routeSkeleton" height={20} width="75%" />
          <Skeleton component="span" className="routeSkeleton" height={24} width={220} />
          <Skeleton component="span" className="routeSkeleton" height={44} width={220} />
        </div>
      </section>

      <section
        className="skillPanel settingsPanel routeLoadingSettingsPanel"
        aria-label="Email reminders loading"
      >
        <div className="settingsSectionIntro">
          <h2 aria-label="Email reminders">
            <Skeleton component="span"
              aria-hidden="true"
              className="routeSkeleton routeLoadingSettingsSectionTitle"
              height={30}
              radius={6}
              width={194}
            />
          </h2>
          <Skeleton component="span"
            className="routeSkeleton"
            height={16}
            radius={5}
            width="min(100%, 540px)"
          />
        </div>

        <div className="settingsReminderForm routeLoadingSettingsForm" aria-hidden="true">
          <fieldset className="skillFormFieldset settingsReminderFieldset">
            <legend>
              <Skeleton component="span" className="routeSkeleton" height={25} radius={6} width={82} />
            </legend>
            <div className="skillFormFieldsetBody settingsReminderFields">
              <div className="settingsSwitchRow">
                <Skeleton component="span" className="routeSkeleton" height={24} radius={999} width={42} />
                <Skeleton component="span" className="routeSkeleton" height={18} radius={5} width={224} />
              </div>

              <label className="skillField">
                <Skeleton component="span" className="routeSkeleton" height={20} radius={5} width={110} />
                <Skeleton component="span" className="routeSkeleton" height={48} radius={8} />
              </label>
            </div>
          </fieldset>

          <fieldset className="skillFormFieldset settingsReminderFieldset">
            <legend>
              <Skeleton component="span" className="routeSkeleton" height={25} radius={6} width={94} />
            </legend>
            <Skeleton component="span"
              className="routeSkeleton"
              height={16}
              radius={5}
              width="min(100%, 600px)"
            />
            <div className="skillFormFieldsetBody settingsReminderFields">
              <div className="skillTwoColumnFields">
                <label className="skillField">
                  <Skeleton component="span" className="routeSkeleton" height={20} radius={5} width={92} />
                  <Skeleton component="span" className="routeSkeleton" height={48} radius={8} />
                </label>

                <label className="skillField">
                  <Skeleton component="span" className="routeSkeleton" height={20} radius={5} width={88} />
                  <Skeleton component="span" className="routeSkeleton" height={48} radius={8} />
                </label>
              </div>

              <label className="skillField">
                <Skeleton component="span" className="routeSkeleton" height={20} radius={5} width={158} />
                <Skeleton component="span" className="routeSkeleton" height={48} radius={8} />
              </label>
            </div>
          </fieldset>

          <div className="skillFormActions">
            <Skeleton component="span"
              className="routeSkeleton routeLoadingActionButton"
              height={42}
              radius={8}
              width={134}
            />
          </div>
        </div>

        <div className="settingsPrivacyNote routeLoadingPrivacyNote" aria-hidden="true">
          <Skeleton component="span"
            className="routeSkeleton"
            height={16}
            radius={5}
            width="min(100%, 610px)"
          />
        </div>
      </section>

      <section
        className="skillPanel settingsExportPanel routeLoadingSettingsExportPanel"
        aria-label="Study data loading"
      >
        <div className="settingsSectionIntro">
          <h2 aria-label="Study data">
            <Skeleton component="span"
              aria-hidden="true"
              className="routeSkeleton routeLoadingSettingsSectionTitle"
              height={30}
              radius={6}
              width={132}
            />
          </h2>
          <Skeleton component="span"
            className="routeSkeleton"
            height={16}
            radius={5}
            width="min(100%, 470px)"
          />
        </div>

        <div className="settingsExportBody" aria-hidden="true">
          <Skeleton component="span" className="routeSkeleton" height={44} radius={7} width="100%" />
          <Skeleton component="span"
            className="routeSkeleton routeLoadingActionButton"
            height={42}
            radius={8}
            width={168}
          />
        </div>

        <dl className="settingsExportFacts" aria-label="Data export details loading">
          {["Scope", "Format", "Access", "Originals"].map((label, index) => (
            <div data-priority={index === 0 ? "primary" : undefined} key={label}>
              <dt>
                <Skeleton component="span" className="routeSkeleton" height={16} radius={5} width={74} />
              </dt>
              <dd>
                <Skeleton component="span"
                  className="routeSkeleton"
                  height={18}
                  radius={5}
                  width={index === 0 ? 116 : 86}
                />
              </dd>
            </div>
          ))}
        </dl>

        <div className="settingsFinePrint" aria-hidden="true">
          <Skeleton component="span"
            className="routeSkeleton"
            height={16}
            radius={5}
            width="min(100%, 640px)"
          />
        </div>
      </section>
    </>
  );
}
