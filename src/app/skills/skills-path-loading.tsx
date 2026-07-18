import { Skeleton, type SkeletonProps } from "@mantine/core";

import { SkillsTopbar, type SkillsTopbarCurrent } from "./skills-topbar";

export type SkillsPathLoadingKind =
  | "skills-library"
  | "new-choice"
  | "new-one"
  | "new-multiple"
  | "materials-library"
  | "material-detail"
  | "material-describe"
  | "material-batch"
  | "skill-detail";

type LoadingRouteConfig = {
  current: SkillsTopbarCurrent;
  label: string;
  shellClassName: string;
};

const loadingRouteConfig: Record<SkillsPathLoadingKind, LoadingRouteConfig> = {
  "skills-library": {
    current: "skills",
    label: "Skills library loading",
    shellClassName: "skillShell",
  },
  "new-choice": {
    current: "new",
    label: "Add skill options loading",
    shellClassName: "skillShell createModeShell",
  },
  "new-one": {
    current: "new",
    label: "One skill form loading",
    shellClassName: "skillShell createSkillShell",
  },
  "new-multiple": {
    current: "new",
    label: "Multiple skills materials loading",
    shellClassName: "skillShell materialShell",
  },
  "materials-library": {
    current: "skills",
    label: "Materials library loading",
    shellClassName: "skillShell materialShell",
  },
  "material-detail": {
    current: "skills",
    label: "Material details loading",
    shellClassName: "skillShell materialShell materialDetailShell",
  },
  "material-describe": {
    current: "new",
    label: "Material skill request loading",
    shellClassName: "skillShell materialShell batchShell",
  },
  "material-batch": {
    current: "new",
    label: "Skill batch loading",
    shellClassName: "skillShell materialShell batchShell",
  },
  "skill-detail": {
    current: "skill",
    label: "Skill details loading",
    shellClassName: "skillShell skillDetailShell",
  },
};

export function SkillsPathLoading({ kind }: { kind: SkillsPathLoadingKind }) {
  const config = loadingRouteConfig[kind];

  return (
    <main
      aria-busy="true"
      aria-label={config.label}
      className={`${config.shellClassName} skillsPathLoading`}
      data-loading-route={kind}
    >
      <SkillsTopbar current={config.current} />
      <SkillsPathLoadingContent kind={kind} />
    </main>
  );
}

function SkillsPathLoadingContent({ kind }: { kind: SkillsPathLoadingKind }) {
  switch (kind) {
    case "skills-library":
      return <SkillsLibraryLoading />;
    case "new-choice":
      return <NewChoiceLoading />;
    case "new-one":
      return <NewOneLoading />;
    case "new-multiple":
      return <NewMultipleLoading />;
    case "materials-library":
      return <MaterialsLibraryLoading />;
    case "material-detail":
      return <MaterialDetailLoading />;
    case "material-describe":
      return <MaterialDescribeLoading />;
    case "material-batch":
      return <MaterialBatchLoading />;
    case "skill-detail":
      return <SkillDetailLoading />;
    default:
      throw new Error(`Unexpected skills loading route: ${kind satisfies never}`);
  }
}

function LoadingBlock({ className, ...props }: SkeletonProps) {
  return (
    <Skeleton
      {...props}
      aria-hidden="true"
      className={`routeSkeleton routeSkeletonShimmer ${className ?? ""}`.trim()}
    />
  );
}

function FixedHeader({
  actionWidths = [],
  breadcrumb,
  className,
  detail,
  title,
}: {
  actionWidths?: number[];
  breadcrumb?: string;
  className?: string;
  detail: string;
  title: string;
}) {
  return (
    <header className={`skillHeader routeLoadingHeader ${className ?? ""}`.trim()} aria-hidden="true">
      <div>
        {breadcrumb ? <p className="materialBreadcrumb">{breadcrumb}</p> : null}
        <h1>{title}</h1>
        <p>{detail}</p>
      </div>
      {actionWidths.length > 0 ? (
        <div className="routeLoadingHeaderActions materialHeaderActions">
          {actionWidths.map((width) => (
            <LoadingBlock height={42} key={width} radius={8} width={width} />
          ))}
        </div>
      ) : null}
    </header>
  );
}

function SkillsLibraryLoading() {
  return (
    <>
      <FixedHeader
        actionWidths={[104, 122]}
        detail="Manage the skills in your practice schedule."
        title="Skills"
      />
      <div className="skillLibraryGrid" data-layout="single" aria-hidden="true">
        <section className="skillPanel routeLoadingPanel">
          <div className="skillPanelHeader">
            <div><h2>Skills</h2></div>
            <LoadingBlock height={30} radius={6} width={76} />
          </div>
          <div className="skillLibraryList">
            <SkillLibraryRowLoading />
            <SkillLibraryRowLoading compact />
            <SkillLibraryRowLoading />
          </div>
        </section>
      </div>
    </>
  );
}

function SkillLibraryRowLoading({ compact = false }: { compact?: boolean }) {
  return (
    <article className="skillLibraryRow routeLoadingLibraryRow">
      <div className="skillLibraryRowMain">
        <div className="routeLoadingLibraryCopy">
          <LoadingBlock height={18} radius={5} width={compact ? "54%" : "72%"} />
          <LoadingBlock height={13} radius={5} width={compact ? "64%" : "86%"} />
        </div>
        <div className="skillLibraryRowControls">
          <LoadingBlock height={25} radius={6} width={62} />
          <LoadingBlock height={34} radius={8} width={34} />
        </div>
      </div>
      <div className="routeLoadingMetaLine">
        <LoadingBlock height={12} radius={5} width={88} />
        <LoadingBlock height={12} radius={5} width={72} />
      </div>
    </article>
  );
}

function NewChoiceLoading() {
  return (
    <>
      <FixedHeader
        className="createModeHeader"
        detail="Use the fast path for one target, or a reusable material for a chapter-sized batch."
        title="What are you adding?"
      />
      <div className="createModeChoices skillsPathChoiceLoading" aria-hidden="true">
        {["One skill", "Multiple skills"].map((label, index) => (
          <article className="createModeChoice" key={label}>
            <LoadingBlock circle height={40} width={40} />
            <span>
              <strong>{label}</strong>
              <LoadingBlock height={13} mt={10} radius={5} width={index === 0 ? "84%" : "92%"} />
              <LoadingBlock height={13} mt={8} radius={5} width={index === 0 ? "66%" : "74%"} />
            </span>
            <LoadingBlock className="createModeChoiceCue" height={12} radius={5} width={72} />
          </article>
        ))}
      </div>
    </>
  );
}

function NewOneLoading() {
  return (
    <>
      <FixedHeader
        breadcrumb="Add / One skill"
        className="createSkillHeader"
        detail="Paste notes, describe a target, or use a short PDF or image."
        title="Create one skill"
      />
      <div className="skillCreateFlow routeLoadingCreateStack" aria-hidden="true">
        <div className="routeLoadingCreateStepper">
          {Array.from({ length: 3 }, (_, index) => (
            <div className="routeLoadingCreateStep" key={index}>
              <LoadingBlock circle height={28} width={28} />
              <div>
                <LoadingBlock height={14} radius={5} width={72} />
                <LoadingBlock height={12} mt={7} radius={5} width={84} />
              </div>
            </div>
          ))}
        </div>
        <section className="skillPanel createSkillPanel routeLoadingCreatePanel">
          <div className="createSkillPanelHeader">
            <h2>Add learning material</h2>
            <LoadingBlock height={42} radius={8} width={126} />
          </div>
          <div className="createSkillInputBox routeLoadingCreateInput">
            <LoadingBlock className="routeLoadingCreateText" height={260} radius={0} />
            <div className="createSkillInputFooter">
              <LoadingBlock height={16} radius={5} width="min(100%, 286px)" />
              <LoadingBlock height={16} radius={5} width={132} />
            </div>
          </div>
          <div className="routeLoadingCreateOptions">
            <LoadingBlock height={24} radius={6} width={148} />
            <LoadingBlock height={14} radius={5} width={220} />
          </div>
          <LoadingBlock height={44} radius={8} width={132} />
        </section>
      </div>
    </>
  );
}

function NewMultipleLoading() {
  return (
    <>
      <FixedHeader
        actionWidths={[154]}
        breadcrumb="Add / Multiple skills"
        className="materialHeader"
        detail="Choose a reusable material now. You will describe and confirm the exact scope next."
        title="Create multiple skills"
      />
      <div className="materialImportLayout" aria-hidden="true">
        <section className="skillPanel materialReusePanel">
          <PanelHeader detail="Select a book or reference you already imported." title="Reuse a material" />
          <div className="materialCompactList">
            <MaterialCompactRowLoading />
            <MaterialCompactRowLoading compact />
          </div>
        </section>
        <section className="skillPanel materialImportPanel">
          <PanelHeader detail="Import once, then return to different chapters over time." title="Add a material" />
          <div className="materialImportTabs skillsPathImportLoading">
            <div className="materialImportTabList">
              <span className="materialImportTab" data-active="true">PDF</span>
              <span className="materialImportTab">Website</span>
            </div>
            <div className="materialImportTabPanel materialImportForm">
              <p className="materialImportIntro">Up to 100 MB or 1,000 pages.</p>
              <div className="skillTwoColumnFields">
                <FieldLoading />
                <FieldLoading compact />
              </div>
              <LoadingBlock className="materialPdfDropzone" height={122} radius={8} />
              <LoadingBlock height={42} radius={8} width={112} />
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function MaterialCompactRowLoading({ compact = false }: { compact?: boolean }) {
  return (
    <article className="materialCompactRow">
      <div>
        <LoadingBlock height={16} radius={5} width={compact ? "62%" : "84%"} />
        <LoadingBlock height={12} mt={8} radius={5} width={compact ? "46%" : "64%"} />
      </div>
      <div className="materialCompactActions">
        <LoadingBlock height={38} radius={8} />
        <LoadingBlock height={38} radius={8} />
      </div>
    </article>
  );
}

function FieldLoading({ compact = false }: { compact?: boolean }) {
  return (
    <div className="skillField">
      <LoadingBlock height={13} radius={4} width={compact ? 68 : 92} />
      <LoadingBlock height={45} mt={8} radius={8} />
    </div>
  );
}

function MaterialsLibraryLoading() {
  return (
    <>
      <FixedHeader
        actionWidths={[130]}
        breadcrumb="Skills / Materials"
        className="materialHeader"
        detail="Reusable textbooks and references, kept at the exact revision used by each skill."
        title="Materials"
      />
      <section className="skillPanel materialLibraryPanel" aria-hidden="true">
        <div className="skillPanelHeader materialLibraryHeader">
          <div>
            <h2>Your references</h2>
            <LoadingBlock height={12} mt={7} radius={5} width={68} />
          </div>
        </div>
        <div className="materialLibraryList">
          <MaterialLibraryRowLoading />
          <MaterialLibraryRowLoading compact />
          <MaterialLibraryRowLoading />
        </div>
      </section>
    </>
  );
}

function MaterialLibraryRowLoading({ compact = false }: { compact?: boolean }) {
  return (
    <article className="materialLibraryRow skillsPathMaterialRowLoading">
      <LoadingBlock circle height={36} width={36} />
      <div className="materialLibraryMain">
        <LoadingBlock height={16} radius={5} width={compact ? "58%" : "82%"} />
        <LoadingBlock height={12} mt={8} radius={5} width={compact ? "38%" : "52%"} />
      </div>
      <div className="materialLibraryFacts">
        {Array.from({ length: 3 }, (_, index) => (
          <LoadingBlock height={12} key={index} radius={5} width={index === 1 ? "76%" : "62%"} />
        ))}
      </div>
      <div className="materialLibraryStatus">
        <LoadingBlock height={24} radius={6} width={62} />
        <LoadingBlock height={11} radius={4} width={56} />
      </div>
    </article>
  );
}

function MaterialDetailLoading() {
  return (
    <>
      <header className="skillHeader materialHeader materialDetailHeader routeLoadingHeader" aria-hidden="true">
        <div className="skillsPathDynamicHeader">
          <LoadingBlock height={13} radius={5} width={240} />
          <LoadingBlock height={42} mt={13} radius={7} width="min(100%, 640px)" />
          <LoadingBlock height={15} mt={12} radius={5} width={166} />
        </div>
        <div className="materialHeaderActions routeLoadingHeaderActions">
          <LoadingBlock height={42} radius={8} width={102} />
          <LoadingBlock height={42} radius={8} width={134} />
        </div>
      </header>
      <section className="materialDetailSummary" aria-hidden="true">
        <div className="materialAvailabilityCopy skillsPathAvailabilityLoading">
          <LoadingBlock circle height={10} width={10} />
          <div>
            <LoadingBlock height={16} radius={5} width={196} />
            <LoadingBlock height={13} mt={7} radius={5} width="min(100%, 510px)" />
          </div>
        </div>
        <div className="materialPageCount">
          <LoadingBlock height={11} radius={4} width={36} />
          <LoadingBlock height={16} mt={5} radius={5} width={42} />
        </div>
      </section>
      <div className="materialDetailGrid" aria-hidden="true">
        <div className="materialDetailMain">
          <section className="skillPanel materialSummaryPanel">
            <div className="materialSummaryHeading">
              <h2>About this material</h2>
              <LoadingBlock height={11} radius={4} width={72} />
            </div>
            <LoadingBlock height={13} mt={18} radius={5} width="94%" />
            <LoadingBlock height={13} mt={9} radius={5} width="76%" />
          </section>
          <section className="skillPanel materialOutlinePanel">
            <PanelHeader detail="Outline sections" title="Outline" />
            <ol className="materialOutlineList skillsPathOutlineLoading">
              {Array.from({ length: 7 }, (_, index) => (
                <li className="skillsPathOutlineRow" key={index}>
                  <LoadingBlock height={14} radius={5} width={`${52 + (index % 3) * 12}%`} />
                  <LoadingBlock height={11} radius={4} width={index % 2 ? 58 : 78} />
                </li>
              ))}
            </ol>
          </section>
        </div>
        <aside className="materialDetailSidebar">
          <DetailSidePanel title="Created skills" rows={2} />
          <DetailSidePanel title="Revision history" rows={2} />
          <section className="skillPanel materialDangerPanel skillsPathDangerLoading">
            <LoadingBlock height={15} radius={5} width={112} />
          </section>
        </aside>
      </div>
    </>
  );
}

function DetailSidePanel({ rows, title }: { rows: number; title: string }) {
  return (
    <section className="skillPanel materialLinkedSkills skillsPathSidePanelLoading">
      <PanelHeader title={title} />
      <div className="materialLinkedSkillList">
        {Array.from({ length: rows }, (_, index) => (
          <div className="skillsPathSideRow" key={index}>
            <LoadingBlock height={14} radius={5} width={index ? "68%" : "84%"} />
            <LoadingBlock height={11} mt={7} radius={4} width={72} />
          </div>
        ))}
      </div>
    </section>
  );
}

function MaterialDescribeLoading() {
  return (
    <>
      <FixedHeader
        actionWidths={[102]}
        breadcrumb="Materials / Describe"
        className="materialHeader batchCreateHeader"
        detail="Describe the exact chapters, sections, or concepts. You will confirm the resolved scope before anything is generated."
        title="What should this book become?"
      />
      <LoadingStageRail currentIndex={0} />
      <section className="skillPanel batchDescribePanel" aria-hidden="true">
        <div className="batchMaterialIdentity skillsPathMaterialIdentityLoading">
          <LoadingBlock circle height={22} width={22} />
          <div>
            <LoadingBlock height={12} radius={4} width={92} />
            <LoadingBlock height={17} mt={8} radius={5} width="90%" />
            <LoadingBlock height={12} mt={8} radius={4} width="68%" />
          </div>
        </div>
        <div className="batchDescribeForm">
          <div className="skillField">
            <span>Skill request</span>
            <LoadingBlock height={144} radius={8} />
          </div>
          <div className="batchRequestExamples">
            <LoadingBlock height={12} radius={4} width={30} />
            <LoadingBlock height={12} radius={4} width={178} />
            <LoadingBlock height={12} radius={4} width={206} />
          </div>
          <div className="skillFormActions batchPrimaryAction">
            <LoadingBlock height={12} radius={4} width={210} />
            <LoadingBlock height={42} radius={8} width={128} />
          </div>
        </div>
      </section>
    </>
  );
}

function LoadingStageRail({ currentIndex }: { currentIndex: number }) {
  const stages = ["Describe", "Review scope", "Generate", "Review skills"];
  return (
    <ol className="batchStageRail" aria-hidden="true">
      {stages.map((stage, index) => (
        <li
          data-state={index < currentIndex ? "complete" : index === currentIndex ? "current" : "upcoming"}
          key={stage}
        >
          <span>{index + 1}</span>
          {stage}
        </li>
      ))}
    </ol>
  );
}

function MaterialBatchLoading() {
  return (
    <>
      <header className="skillHeader materialHeader batchHeader routeLoadingHeader" aria-hidden="true">
        <div className="skillsPathDynamicHeader">
          <p className="materialBreadcrumb">Materials / Skill batch</p>
          <LoadingBlock height={42} radius={7} width="min(100%, 430px)" />
          <LoadingBlock height={15} mt={12} radius={5} width="min(100%, 560px)" />
        </div>
        <LoadingBlock height={42} radius={8} width={102} />
      </header>
      <LoadingStageRail currentIndex={1} />
      <div className="batchScopeLayout" aria-hidden="true">
        <section className="skillPanel batchScopePanel">
          <div className="batchScopeHeader">
            <div>
              <LoadingBlock height={12} radius={4} width={126} />
              <LoadingBlock height={20} mt={9} radius={5} width={260} />
            </div>
            <LoadingBlock height={30} radius={999} width={82} />
          </div>
          <ol className="batchScopeItems">
            {Array.from({ length: 3 }, (_, index) => (
              <li className="skillsPathScopeRow" key={index}>
                <LoadingBlock circle height={25} width={25} />
                <div>
                  <LoadingBlock height={15} radius={5} width={`${62 + index * 8}%`} />
                  <LoadingBlock height={13} mt={9} radius={5} width="92%" />
                  <LoadingBlock height={11} mt={8} radius={4} width={86} />
                </div>
              </li>
            ))}
          </ol>
          <div className="batchConfirmBar">
            <LoadingBlock height={12} radius={4} width={210} />
            <LoadingBlock height={42} radius={8} width={158} />
          </div>
        </section>
        <aside className="skillPanel batchScopeCorrection">
          <div><h2>Change the request</h2></div>
          <section className="skillsPathCorrectionLoading">
            <div className="skillField">
              <LoadingBlock height={13} radius={4} width={92} />
              <LoadingBlock height={132} mt={8} radius={8} />
            </div>
            <LoadingBlock height={42} radius={8} />
          </section>
        </aside>
      </div>
    </>
  );
}

function SkillDetailLoading() {
  return (
    <div className="skillDetailOverview" aria-hidden="true">
      <div className="skillDetailCanvas">
        <header className="skillDetailHero skillsPathSkillHeroLoading">
          <div>
            <LoadingBlock height={36} radius={7} width="min(100%, 680px)" />
            <LoadingBlock height={15} mt={14} radius={5} width="min(100%, 740px)" />
            <LoadingBlock height={15} mt={9} radius={5} width="min(82%, 590px)" />
            <div className="skillDetailTags">
              <LoadingBlock height={25} radius={6} width={82} />
              <LoadingBlock height={25} radius={6} width={106} />
            </div>
          </div>
          <LoadingBlock height={42} radius={8} width={122} />
        </header>
        <section className="skillDetailCard skillDetailSchedule">
          <SkillDetailSectionHeaderLoading title="Schedule" />
          <div className="skillDetailFactGrid skillsPathFactGridLoading">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index}>
                <LoadingBlock height={12} radius={4} width={index ? 52 : 84} />
                <LoadingBlock height={17} mt={8} radius={5} width={index ? 74 : 116} />
              </div>
            ))}
          </div>
        </section>
        <section className="skillDetailCard skillDetailGuidance">
          <SkillDetailSectionHeaderLoading title="Practice guidance" />
          <div className="skillsPathGuidanceLoading">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index}>
                <LoadingBlock height={14} radius={5} width={index === 0 ? 86 : 112} />
                <LoadingBlock height={13} mt={10} radius={5} width="94%" />
                <LoadingBlock height={13} mt={8} radius={5} width={index === 2 ? "64%" : "78%"} />
              </div>
            ))}
          </div>
        </section>
        <section className="skillDetailCard skillDetailOutcomes">
          <SkillDetailSectionHeaderLoading title="Review outcomes" />
          <div className="skillsPathOutcomeLoading">
            <LoadingBlock height={15} radius={5} width={176} />
            <LoadingBlock height={13} mt={12} radius={5} width="68%" />
          </div>
        </section>
      </div>
    </div>
  );
}

function SkillDetailSectionHeaderLoading({ title }: { title: string }) {
  return (
    <div className="skillDetailSectionHeader">
      <div>
        <h2>{title}</h2>
        <LoadingBlock height={13} mt={8} radius={5} width={214} />
      </div>
    </div>
  );
}

function PanelHeader({ detail, title }: { detail?: string; title: string }) {
  return (
    <div className="skillPanelHeader">
      <div>
        <h2>{title}</h2>
        {detail ? <p>{detail}</p> : null}
      </div>
    </div>
  );
}
