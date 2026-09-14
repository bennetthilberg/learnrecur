"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { SkillsTopbar, type SkillsTopbarCurrent } from "@/app/skills/skills-topbar";

export function PageError({ reset }: { reset: () => void }) {
  const pathname = usePathname();
  const heading = useRef<HTMLHeadingElement>(null);
  const current: SkillsTopbarCurrent = pathname.startsWith("/practice") ? "practice"
    : pathname.startsWith("/skills/new") ? "new"
    : pathname.startsWith("/skills") ? "skills"
    : pathname.startsWith("/history") ? "history"
    : pathname.startsWith("/collections") ? "collections"
    : pathname.startsWith("/settings") ? "settings" : "dashboard";
  useEffect(() => { heading.current?.focus(); }, []);

  return (
    <main className="practiceShell">
      <SkillsTopbar current={current} />
      <section className="practiceFrame practiceEmpty" aria-labelledby="page-error-title">
        <h1 id="page-error-title" ref={heading} tabIndex={-1}>This page couldn’t load</h1>
        <p>Try again, or open another page while we reconnect.</p>
        <div className="practiceActions">
          <Link className="secondaryButton" href={current === "dashboard" ? "/skills" : "/dashboard"}>
            {current === "dashboard" ? "Open skills" : "Go to dashboard"}
          </Link>
          <button className="primaryButton" type="button" onClick={reset}>Try again</button>
        </div>
      </section>
    </main>
  );
}
