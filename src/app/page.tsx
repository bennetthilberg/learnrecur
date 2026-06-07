import { auth } from "@clerk/nextjs/server";
import Link from "next/link";

export default async function Home() {
  const { userId } = await auth();

  return (
    <main className="entryShell">
      <section className="entryPanel" aria-labelledby="home-title">
        <p className="eyebrow">LearnRecur</p>
        <h1 id="home-title">Skill practice, scheduled by memory.</h1>
        <p>
          Upload a page, paste notes, or define a skill. Review the draft, then work
          through verified exercises whenever the schedule says it is time.
        </p>
        <div className="entryActions">
          {userId ? (
            <>
              <Link className="primaryButton" href="/practice">
                Start practice
              </Link>
              <Link className="secondaryButton" href="/dashboard">
                Open dashboard
              </Link>
            </>
          ) : (
            <>
              <Link className="primaryButton" href="/sign-in">
                Sign in
              </Link>
              <Link className="secondaryButton" href="/sign-up">
                Create account
              </Link>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
