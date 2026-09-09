import { getUserPracticePreferences } from "@/lib/practice/preferences";
import { auth, currentUser } from "@clerk/nextjs/server";

import { UserStatusPanel } from "@/components/app/user-status-panel";
import { ensureDatabaseUser } from "@/lib/users";

import { SkillsTopbar } from "../skills/skills-topbar";
import { PracticeLoader } from "./practice-loader";
import { CustomPracticeLoader } from "./custom-practice-loader";

export const dynamic = "force-dynamic";

type PracticePageProps = {
  searchParams?: Promise<{
    collectionId?: string | string[];
    sessionId?: string | string[];
  }>;
};

export default async function PracticePage({ searchParams }: PracticePageProps) {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const collectionId = parseCollectionId(resolvedSearchParams.collectionId);
  const sessionId = parseCollectionId(resolvedSearchParams.sessionId);

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

  const preferences = await getUserPracticePreferences(userId);
  return (
    <main className="practiceShell">
      <SkillsTopbar current="practice" />

      {sessionId ? (
        <CustomPracticeLoader key={sessionId} sessionId={sessionId} />
      ) : (
        <PracticeLoader
          key={collectionId ?? "all"}
          collectionId={collectionId}
          initialMixedReview={preferences.mixedReview}
          canUseSampleData={process.env.NODE_ENV !== "production"}
        />
      )}
    </main>
  );
}

function parseCollectionId(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0]?.trim() || null;
  }

  return value?.trim() || null;
}
