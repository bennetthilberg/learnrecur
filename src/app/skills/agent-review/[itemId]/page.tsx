import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { UserStatusPanel } from "@/components/app/user-status-panel";
import { getAgentDuplicateReview } from "@/lib/agent-access/settings";
import { ensureDatabaseUser } from "@/lib/users";

import { SkillsTopbar } from "../../skills-topbar";
import { resolveDuplicateReviewAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function AgentDuplicateReviewPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();
  if (!clerkUser) throw new Error("Clerk returned no authenticated user.");
  const databaseUser = await ensureDatabaseUser(clerkUser);
  if (databaseUser.status !== "ready") {
    return <main className="skillShell"><SkillsTopbar current="skills" /><UserStatusPanel id="agent-review-setup" status={databaseUser} /></main>;
  }
  const { itemId } = await params;
  const review = await getAgentDuplicateReview({ userId, itemId });
  if (!review?.resultSkill) notFound();

  return (
    <main className="skillShell agentDuplicateReviewShell">
      <SkillsTopbar current="skills" />
      <header className="skillHeader agentDuplicateReviewHeader">
        <div><h1>Review possible duplicate</h1><p>{review.operation.connection.clientName} proposed a skill that overlaps one you already have.</p></div>
        <Link className="secondaryButton" href="/skills">Back to skills</Link>
      </header>

      <section className="skillPanel agentDuplicateCompare" aria-labelledby="duplicate-compare-title">
        <div className="skillPanelHeader"><div><h2 id="duplicate-compare-title">Compare the two skills</h2><p>No new skill will activate until you choose.</p></div></div>
        <div className="agentDuplicateColumns">
          <article>
            <span>Agent proposal</span>
            <h3>{review.proposedTitle ?? "Untitled proposal"}</h3>
            <p>{review.proposedObjective ?? "No objective provided."}</p>
          </article>
          <article>
            <span>Existing skill</span>
            <h3><Link href={`/skills/${review.resultSkill.id}`}>{review.resultSkill.title}</Link></h3>
            <p>{review.resultSkill.objective ?? "No objective provided."}</p>
            <div className="skillMetaLine"><span>{review.resultSkill.collection?.name ?? "Uncollected"}</span>{review.resultSkill.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</div>
          </article>
        </div>
        <form action={resolveDuplicateReviewAction} className="agentDuplicateActions">
          <input type="hidden" name="itemId" value={review.id} />
          <button className="secondaryButton" name="decision" value="use-existing" type="submit">Use existing</button>
          <button className="primaryButton" name="decision" value="create-separately" type="submit">Review proposal and create separately</button>
        </form>
      </section>
    </main>
  );
}
