import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";

import { CollectionStatus, SkillStatus } from "@/generated/prisma/client";
import { getUserPracticePreferences } from "@/lib/practice/preferences";
import { getPrisma } from "@/lib/prisma";
import { resolveCustomPracticeSkillPrefill } from "@/lib/practice/custom-session-contracts";
import { ensureDatabaseUser } from "@/lib/users";

import { SkillsTopbar } from "../../skills/skills-topbar";
import { CustomSessionSetup } from "./custom-session-setup";

export const dynamic = "force-dynamic";

type CustomPracticePageProps = {
  searchParams?: Promise<{
    skillId?: string | string[];
  }>;
};

function parseQueryValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0]?.trim() || null;
  return value?.trim() || null;
}

export default async function CustomPracticePage({
  searchParams,
}: CustomPracticePageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();
  if (!clerkUser) {
    throw new Error(`Clerk returned no user for authenticated user ${userId}.`);
  }
  const databaseUser = await ensureDatabaseUser(clerkUser);
  if (databaseUser.status !== "ready") {
    return (
      <main className="practiceShell">
        <SkillsTopbar current="practice" />
        <section className="practiceFrame practiceEmpty">
          <h1>Practice setup is unavailable.</h1>
          <p>{databaseUser.message}</p>
        </section>
      </main>
    );
  }

  const [preferences, collections, skills] = await Promise.all([
    getUserPracticePreferences(userId),
    getPrisma().collection.findMany({
      where: { userId, status: CollectionStatus.ACTIVE },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true },
    }),
    getPrisma().skill.findMany({
      where: { userId, status: SkillStatus.ACTIVE },
      orderBy: [{ title: "asc" }, { id: "asc" }],
      select: { id: true, title: true, collectionId: true, tags: true },
    }),
  ]);
  const tags = [...new Set(skills.flatMap((skill) => skill.tags))].toSorted((a, b) =>
    a.localeCompare(b),
  );
  const requestedSkillId = parseQueryValue(resolvedSearchParams.skillId);
  const initialSkillId = resolveCustomPracticeSkillPrefill(
    requestedSkillId,
    skills.map((skill) => skill.id),
  );

  return (
    <main className="practiceShell">
      <SkillsTopbar current="practice" />
      <header className="skillHeader customPracticeHeader">
        <div>
          <h1>Set up a custom session</h1>
          <p>Choose the skills you want to see now. Practice only is selected by default and never changes your schedule.</p>
        </div>
        <div className="materialHeaderActions">
          <Link className="secondaryButton" href="/practice">Normal practice</Link>
          <Link className="secondaryButton" href="/practice/attention">Needs attention</Link>
        </div>
      </header>
      <CustomSessionSetup
        collections={collections}
        initialMixedReview={preferences.mixedReview}
        initialSkillId={initialSkillId}
        skills={skills}
        tags={tags}
      />
    </main>
  );
}
