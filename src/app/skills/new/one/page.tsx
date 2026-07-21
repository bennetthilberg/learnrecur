import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";

import { UserStatusPanel } from "@/components/app/user-status-panel";
import { getSkillCreationSourceRecoveryItems } from "@/lib/skills/source-recovery";
import { ensureDatabaseUser } from "@/lib/users";

import { SourceCreationWorkspace } from "../../source-creation-workspace";
import { SkillsTopbar } from "../../skills-topbar";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export default async function NewOneSkillPage() {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();

  if (!clerkUser) {
    throw new Error(`Clerk returned no user for authenticated user ${userId}.`);
  }

  const databaseUser = await ensureDatabaseUser(clerkUser);
  if (databaseUser.status !== "ready") {
    return (
      <main className="skillShell">
        <SkillsTopbar current="new" />
        <UserStatusPanel id="skills-setup-title" status={databaseUser} />
      </main>
    );
  }

  const recoverableSourceUploads = await getSkillCreationSourceRecoveryItems({
    userId,
    now: new Date(),
  });

  return (
    <main className="skillShell createSkillShell">
      <SkillsTopbar current="new" />
      <header className="skillHeader createSkillHeader">
        <div>
          <p className="materialBreadcrumb"><Link href="/skills/new">Add</Link> / One skill</p>
          <h1>Create one skill</h1>
          <p>Paste notes, describe a target, or use a short PDF or image.</p>
        </div>
      </header>
      <SourceCreationWorkspace recoverableSourceUploads={recoverableSourceUploads} />
    </main>
  );
}
