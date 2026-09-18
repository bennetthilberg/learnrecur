import { auth, currentUser } from "@clerk/nextjs/server";

import { UserStatusPanel } from "@/components/app/user-status-panel";
import {
  getPracticeHistoryPage,
} from "@/lib/practice/history";
import { ensureDatabaseUser } from "@/lib/users";

import { SkillsTopbar } from "../skills/skills-topbar";
import { HistoryBrowser } from "./history-browser";
import { toHistoryReviewRow } from "./history-row";
import { getPrisma } from "@/lib/prisma";
import { HistoryFilters } from "./history-filters";

export const dynamic = "force-dynamic";

export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const value = (key: string) => typeof query[key] === "string" ? query[key] as string : "";
  const filters = {
    skillId: value("skillId") || undefined,
    collectionId: value("collectionId") || undefined,
    incorrectOnly: value("incorrectOnly") === "on",
    mode: value("mode") === "practice-only" ? "practice-only" as const : "scheduled" as const,
  };
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();

  if (!clerkUser) {
    throw new Error("Clerk returned no authenticated user.");
  }

  const databaseUser = await ensureDatabaseUser(clerkUser);

  if (databaseUser.status !== "ready") {
    return (
      <main className="skillShell">
        <SkillsTopbar current="history" />
        <UserStatusPanel id="history-setup-title" status={databaseUser} />
      </main>
    );
  }

  const history = await getPracticeHistoryPage({
    ...filters,
    userId,
    now: new Date(),
  });

  const reviewRows = history.reviews.map(toHistoryReviewRow);
  const [skills, collections] = await Promise.all([
    getPrisma().skill.findMany({ where: { userId }, select: { id: true, title: true }, orderBy: { title: "asc" } }),
    getPrisma().collection.findMany({ where: { userId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <main className="skillShell historyShell">
      <SkillsTopbar current="history" />

      <header className="skillHeader historyHeader">
        <div>
          <h1>History</h1>
          <p>
            See your recent review results, ratings, and next due dates. Choose
            Details for the answer, response time, and schedule change. Practice-only
            exposures are available from the Activity filter and never change FSRS.
          </p>
        </div>
      </header>

      <HistoryFilters key={JSON.stringify(filters)} filters={filters} skills={skills} collections={collections} />
      <section className="skillPanel historyPanel" aria-labelledby="review-history-title">
        <div className="historyPanelIntro">
          <h2 id="review-history-title">Practice history</h2>

        </div>

        <HistoryBrowser key={JSON.stringify(filters)} initialReviews={reviewRows} initialCursor={history.nextCursor} filters={filters} />
      </section>
    </main>
  );
}
