import { Skeleton } from "@mantine/core";
import { SkillsTopbar } from "../../skills/skills-topbar";

export default function CustomPracticeLoading() {
  return (
    <main className="practiceShell" aria-busy="true">
      <SkillsTopbar current="practice" />
      <header className="skillHeader customPracticeHeader">
        <div>
          <h1>Set up a custom session</h1>
          <p>
            Choose the skills you want to see now. Practice only is selected by
            default and never changes your schedule.
          </p>
        </div>
      </header>
      <section
        className="skillPanel customPracticeSetup"
        aria-label="Session choices loading"
      >
        <div className="skillPanelHeader">
          <h2>Session choices</h2>
        </div>
        <div className="customPracticeSetupGrid" aria-hidden="true">
          {["Mode", "Exercises", "Scope", "Selected skills"].map((label) => (
            <div key={label} className="customPracticeLoadingField">
              <span className="customPracticeLegend">{label}</span>
              <Skeleton className="routeSkeleton" height={48} radius={8} />
              <Skeleton
                className="routeSkeleton"
                height={18}
                width="70%"
                radius={5}
              />
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
