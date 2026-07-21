import { BookOpenText, Cards } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

import { SkillsTopbar } from "../skills-topbar";

export default async function NewSkillPage() {
  return (
    <main className="skillShell createModeShell">
      <SkillsTopbar current="new" />
      <header className="skillHeader createModeHeader">
        <div>
          <h1>What are you adding?</h1>
          <p>Use the fast path for one target, or a reusable material for a chapter-sized batch.</p>
        </div>
      </header>
      <div className="createModeChoices">
        <Link className="createModeChoice" href="/skills/new/one">
          <span className="createModeChoiceIcon"><Cards size={24} weight="bold" aria-hidden="true" /></span>
          <span>
            <strong>One skill</strong>
            <small>Paste notes, use images, or upload a short focused PDF.</small>
          </span>
          <span className="createModeChoiceCue" aria-hidden="true">Fast create</span>
        </Link>
        <Link className="createModeChoice" href="/skills/new/multiple">
          <span className="createModeChoiceIcon"><BookOpenText size={24} weight="bold" aria-hidden="true" /></span>
          <span>
            <strong>Multiple skills</strong>
            <small>Reuse a textbook, long PDF, or public book-like website.</small>
          </span>
          <span className="createModeChoiceCue" aria-hidden="true">Materials</span>
        </Link>
      </div>
    </main>
  );
}
