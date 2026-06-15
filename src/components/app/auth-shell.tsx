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
          <h1 id="auth-title">{title}</h1>
          <p>{description}</p>
        </section>
        <section className="authCardColumn" aria-label={title}>
          <div className="authCard">{children}</div>
        </section>
      </div>
    </main>
  );
}
