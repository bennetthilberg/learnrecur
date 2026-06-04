import { UserButton } from "@clerk/nextjs";
import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";

import { hasClerkEnv } from "@/lib/env";
import { ensureDatabaseUser } from "@/lib/users";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();
  const clerkEnvReady = hasClerkEnv();

  if (!clerkUser) {
    throw new Error(`Clerk returned no user for authenticated user ${userId}.`);
  }

  const databaseUser = await ensureDatabaseUser(clerkUser);

  return (
    <main className="dashboardShell">
      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">Authenticated app spine</p>
          <h1>Dashboard setup check.</h1>
        </div>
        <UserButton />
      </header>

      <section className="statusGrid" aria-label="Setup status">
        <article className="statusPanel">
          <p className="statusLabel">Clerk</p>
          <h2>Signed in</h2>
          <dl>
            <div>
              <dt>User ID</dt>
              <dd>{userId}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{clerkUser.primaryEmailAddress?.emailAddress ?? "No primary email"}</dd>
            </div>
            <div>
              <dt>Environment</dt>
              <dd>{clerkEnvReady ? "Clerk keys loaded" : "Add Clerk keys to .env.local"}</dd>
            </div>
          </dl>
        </article>

        <article className="statusPanel">
          <p className="statusLabel">Database</p>
          {databaseUser.status === "ready" ? (
            <>
              <h2>User mirror ready</h2>
              <dl>
                <div>
                  <dt>DB user ID</dt>
                  <dd>{databaseUser.user.id}</dd>
                </div>
                <div>
                  <dt>Created</dt>
                  <dd>{databaseUser.user.createdAt.toLocaleString()}</dd>
                </div>
              </dl>
            </>
          ) : (
            <>
              <h2>Needs setup</h2>
              <p>{databaseUser.message}</p>
            </>
          )}
        </article>
      </section>

      <section className="nextStepPanel" aria-labelledby="next-step-title">
        <p className="eyebrow">Practice</p>
        <h2 id="next-step-title">Review flow is ready for a first pass.</h2>
        <p>
          Start with the multiple-choice practice loop. If no exercises are due in
          local development, the practice page can prepare a small sample set.
        </p>
        <div className="entryActions">
          <Link className="primaryButton" href="/practice">
            Start practice
          </Link>
        </div>
      </section>
    </main>
  );
}
