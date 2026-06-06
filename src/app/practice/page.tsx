import { UserButton } from "@clerk/nextjs";
import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";

import { ensureDatabaseUser } from "@/lib/users";

import { getNextPracticeItemForUser } from "./queries";
import { PracticeClient } from "./practice-client";

export const dynamic = "force-dynamic";

export default async function PracticePage() {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();

  if (!clerkUser) {
    throw new Error(`Clerk returned no user for authenticated user ${userId}.`);
  }

  const databaseUser = await ensureDatabaseUser(clerkUser);

  if (databaseUser.status !== "ready") {
    return (
      <main className="practiceShell">
        <header className="practiceTopbar">
          <Link className="practiceWordmark" href="/dashboard">
            LearnRecur
          </Link>
          <UserButton />
        </header>

        <section className="practiceFrame practiceEmpty" aria-labelledby="practice-setup-title">
          <p className="eyebrow">Practice</p>
          <h1 id="practice-setup-title">Database setup needs attention.</h1>
          <p>{databaseUser.message}</p>
        </section>
      </main>
    );
  }

  const initialItem = await getNextPracticeItemForUser(userId);

  return (
    <main className="practiceShell">
      <header className="practiceTopbar">
        <Link className="practiceWordmark" href="/dashboard">
          LearnRecur
        </Link>
        <nav className="practiceNav" aria-label="Practice navigation">
          <Link href="/dashboard">Dashboard</Link>
          <Link aria-current="page" href="/practice">
            Practice
          </Link>
          <Link href="/skills">Skills</Link>
          <Link href="/collections">Collections</Link>
          <Link href="/skills/new">Add skill</Link>
        </nav>
        <UserButton />
      </header>

      <PracticeClient
        initialItem={initialItem}
        canUseSampleData={process.env.NODE_ENV !== "production"}
      />
    </main>
  );
}
