import { auth, currentUser } from "@clerk/nextjs/server";

import { ensureDatabaseUser } from "@/lib/users";

import { SkillDraftForm, type SkillDraftFormValues } from "../skill-draft-form";
import { SkillsTopbar } from "../skills-topbar";

export const dynamic = "force-dynamic";

const emptyDraftValues: SkillDraftFormValues = {
  title: "",
  objective: "",
  collectionName: "",
  rules: "",
  examples: "",
  exerciseConstraints: "",
  tags: "",
};

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
        <section className="dashboardSetupPanel" aria-labelledby="skills-setup-title">
          <p className="eyebrow">Skills</p>
          <h1 id="skills-setup-title">Database setup needs attention.</h1>
          <p>{databaseUser.message}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="skillShell">
      <SkillsTopbar current="new" />
      <header className="skillHeader">
        <div>
          <p className="eyebrow">New skill</p>
          <h1>Define the skill before generation.</h1>
          <p>
            This draft is the review object. Gemini will only generate starter
            multiple-choice exercises after you activate it.
          </p>
        </div>
      </header>
      <SkillDraftForm initialValues={emptyDraftValues} mode="create" />
    </main>
  );
}
