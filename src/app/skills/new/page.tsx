import { auth, currentUser } from "@clerk/nextjs/server";

import { ensureDatabaseUser } from "@/lib/users";

import { SkillDraftForm, type SkillDraftFormValues } from "../skill-draft-form";
import { SourceUploadForm } from "../source-upload-form";
import { SkillsTopbar } from "../skills-topbar";
import { SourceSkillForm } from "../source-skill-form";

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
          <h1>Create skill drafts.</h1>
          <p>
            Upload or paste source material for Gemini to shape one or more editable
            drafts, or define the skill manually. You will review it before activation.
          </p>
        </div>
      </header>
      <div className="skillCreateStack">
        <section className="skillSourceEntryGrid" aria-label="Source-backed draft options">
          <SourceUploadForm />
          <SourceSkillForm />
        </section>
        <section className="skillManualSection" aria-labelledby="manual-skill-title">
          <div className="skillManualIntro">
            <p className="eyebrow">Manual draft</p>
            <h2 id="manual-skill-title">Write the skill yourself.</h2>
            <p>
              Use this when you already know the exact skill definition and do not
              need Gemini to interpret source material first.
            </p>
          </div>
          <SkillDraftForm initialValues={emptyDraftValues} mode="create" />
        </section>
      </div>
    </main>
  );
}
