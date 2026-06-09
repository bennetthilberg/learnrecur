import { auth, currentUser } from "@clerk/nextjs/server";

import { ensureDatabaseUser } from "@/lib/users";

import { SkillsTopbar } from "../skills/skills-topbar";
import { getNextPracticeItemForUser } from "./queries";
import { PracticeClient } from "./practice-client";

export const dynamic = "force-dynamic";

type PracticePageProps = {
  searchParams?: Promise<{
    collectionId?: string | string[];
  }>;
};

export default async function PracticePage({ searchParams }: PracticePageProps) {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const collectionId = parseCollectionId(resolvedSearchParams.collectionId);

  if (!clerkUser) {
    throw new Error(`Clerk returned no user for authenticated user ${userId}.`);
  }

  const databaseUser = await ensureDatabaseUser(clerkUser);

  if (databaseUser.status !== "ready") {
    return (
      <main className="practiceShell">
        <SkillsTopbar current="practice" />

        <section className="dashboardSetupPanel" aria-labelledby="practice-setup-title">
          <p className="eyebrow">Practice</p>
          <h1 id="practice-setup-title">Database setup needs attention.</h1>
          <p>{databaseUser.message}</p>
        </section>
      </main>
    );
  }

  const initialItem = await getNextPracticeItemForUser(userId, new Date(), {
    collectionId,
  });

  return (
    <main className="practiceShell">
      <SkillsTopbar current="practice" />

      <PracticeClient
        initialItem={initialItem}
        canUseSampleData={process.env.NODE_ENV !== "production"}
      />
    </main>
  );
}

function parseCollectionId(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0]?.trim() || null;
  }

  return value?.trim() || null;
}
