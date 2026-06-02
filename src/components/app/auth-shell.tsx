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
      </section>
      <section className="authCard" aria-label={title}>
        {children}
      </section>
    </main>
  );
}
