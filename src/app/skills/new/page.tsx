import { SkillsTopbar } from "../skills-topbar";
import { AddChoices } from "./add-choices";

export default function NewSkillPage() {
  return (
    <main className="skillShell createModeShell">
      <SkillsTopbar current="new" />
      <AddChoices />
    </main>
  );
}
