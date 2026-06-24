import { auth, currentUser } from "@clerk/nextjs/server";

import { UserStatusPanel } from "@/components/app/user-status-panel";
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
        <UserStatusPanel id="practice-setup-title" status={databaseUser} />
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
