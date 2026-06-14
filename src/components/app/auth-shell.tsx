import Link from "next/link";

import { OpenWaterBackground, OpenWaterLogoMark } from "@/components/app/open-water";

type AuthShellProps = {
  title: string;
  description: string;
  children: React.ReactNode;
};

export function AuthShell({ title, description, children }: AuthShellProps) {
  return (
    <main className="authShell">
      <OpenWaterBackground />
      <div className="authLayout">
        <section className="authIntro" aria-labelledby="auth-title">
          <Link className="wordmark" href="/">
            <OpenWaterLogoMark />
            <span>LearnRecur</span>
          </Link>
          <p className="eyebrow">Account access</p>
          <h1 id="auth-title">{title}</h1>
          <p>{description}</p>
          <dl className="authAccessList" aria-label="Account workspace includes">
            <div>
              <dt>Due practice</dt>
              <dd>Scheduled skills and current review readiness.</dd>
            </div>
            <div>
              <dt>Drafts and sources</dt>
              <dd>Private source material, editable drafts, and exercise inventory.</dd>
            </div>
            <div>
              <dt>Review record</dt>
              <dd>Completed reviews, grading outcomes, and reminder preferences.</dd>
            </div>
          </dl>
        </section>
        <section className="authCardColumn" aria-label={title}>
          <div className="authCard">{children}</div>
        </section>
      </div>
    </main>
  );
}
