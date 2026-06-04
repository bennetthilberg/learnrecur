import { auth } from "@clerk/nextjs/server";
import Link from "next/link";

export default async function Home() {
  const { userId } = await auth();

  return (
    <main className="entryShell">
      <section className="entryPanel" aria-labelledby="home-title">
        <p className="eyebrow">LearnRecur</p>
        <h1 id="home-title">Focused practice, ready for real accounts.</h1>
        <p>
          The design lab has been retired. This first application slice is now set up
          for Clerk authentication and a Neon-backed Prisma database.
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
