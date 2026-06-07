import { UserButton } from "@clerk/nextjs";
import Link from "next/link";

export function SkillsTopbar({
  current,
}: {
  current:
    | "dashboard"
    | "practice"
    | "history"
    | "skills"
    | "collections"
    | "settings"
    | "new"
    | "skill";
}) {
  return (
    <header className="practiceTopbar">
      <Link className="practiceWordmark" href="/dashboard">
        LearnRecur
      </Link>
      <nav className="practiceNav" aria-label="Primary navigation">
        <Link aria-current={current === "dashboard" ? "page" : undefined} href="/dashboard">
          Dashboard
        </Link>
        <Link aria-current={current === "practice" ? "page" : undefined} href="/practice">
          Practice
        </Link>
        <Link aria-current={current === "history" ? "page" : undefined} href="/history">
          History
        </Link>
        <Link
          aria-current={current === "skills" || current === "skill" ? "page" : undefined}
          href="/skills"
        >
          Skills
        </Link>
        <Link aria-current={current === "collections" ? "page" : undefined} href="/collections">
          Collections
        </Link>
        <Link aria-current={current === "settings" ? "page" : undefined} href="/settings">
          Settings
        </Link>
        <Link
          aria-current={current === "new" ? "page" : undefined}
          href="/skills/new"
        >
          Add skill
        </Link>
      </nav>
      <UserButton />
    </header>
  );
}
