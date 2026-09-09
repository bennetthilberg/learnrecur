import { SkillsTopbar } from "../../skills/skills-topbar";

export default function NeedsAttentionLoading() {
  return (
    <main className="practiceShell practiceAttentionShell">
      <SkillsTopbar current="practice" />
      <div className="practiceAttentionPage" aria-busy="true" aria-live="polite">
        <header className="practiceAttentionHeader">
          <div>
            <h1>Needs attention</h1>
            <p>Checking recent review evidence and current preparation state.</p>
          </div>
        </header>
        <div className="practiceAttentionLoadingList" aria-hidden="true">
          <div className="practiceAttentionSkeleton practiceAttentionSkeletonShort" />
          <div className="practiceAttentionSkeleton" />
          <div className="practiceAttentionSkeleton" />
        </div>
      </div>
    </main>
  );
}
