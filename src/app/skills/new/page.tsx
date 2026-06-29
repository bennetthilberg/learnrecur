import { auth, currentUser } from "@clerk/nextjs/server";

import { UserStatusPanel } from "@/components/app/user-status-panel";
import { getSkillsLibrary } from "@/lib/skills/library";
import { ensureDatabaseUser } from "@/lib/users";

import { SourceCreationWorkspace } from "../source-creation-workspace";
import { SkillsTopbar } from "../skills-topbar";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export default async function NewSkillPage() {
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

  const library = await getSkillsLibrary({
    userId,
    now: new Date(),
  });
  const recoverableSourceUploads = library.sourceProcessing
    .filter((sourceFile) => sourceFile.canRequeue)
    .map((sourceFile) => ({
      id: sourceFile.id,
      errorMessage: sourceFile.errorMessage,
      isStaleProcessing: sourceFile.isStaleProcessing,
      originalName: sourceFile.originalName,
      status: sourceFile.status,
    }));

  return (
    <main className="skillShell createSkillShell">
      <SkillsTopbar current="new" />
      <header className="skillHeader createSkillHeader">
        <div>
          <h1>Create a skill</h1>
          <p>
            Paste notes, describe what you want to practice, or drop in a PDF or image.
          </p>
        </div>
      </header>
      <SourceCreationWorkspace recoverableSourceUploads={recoverableSourceUploads} />
    </main>
  );
}
