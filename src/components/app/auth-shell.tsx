import Link from "next/link";

type AuthShellProps = {
  title: string;
  description: string;
  children: React.ReactNode;
};

export function AuthShell({ title, description, children }: AuthShellProps) {
  return (
    <main className="authShell">
      <section className="authIntro" aria-labelledby="auth-title">
        <Link className="wordmark" href="/">
          LearnRecur
        </Link>
        <p className="eyebrow">Account access</p>
        <h1 id="auth-title">{title}</h1>
        <p>{description}</p>
        <dl className="authAccessList" aria-label="Account workspace includes">
          <div>
            <dt>Due queue</dt>
            <dd>Scheduled skills and current practice readiness.</dd>
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
      <section className="authCard" aria-label={title}>
        {children}
      </section>
    </main>
  );
}
