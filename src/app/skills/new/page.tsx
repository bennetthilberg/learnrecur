import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";

import { UserStatusPanel } from "@/components/app/user-status-panel";
import { ensureDatabaseUser } from "@/lib/users";

import { SkillDraftForm, type SkillDraftFormValues } from "../skill-draft-form";
import { SourceUploadForm } from "../source-upload-form";
import { SkillsTopbar } from "../skills-topbar";
import { SourceSkillForm } from "../source-skill-form";

export const dynamic = "force-dynamic";

type NewSkillPageProps = {
  searchParams?: Promise<{
    mode?: string | string[];
  }>;
};

type SkillCreationMode = "auto" | "manual";

const emptyDraftValues: SkillDraftFormValues = {
  title: "",
  objective: "",
  collectionName: "",
  rules: "",
  examples: "",
  exerciseConstraints: "",
  tags: "",
};

export default async function NewSkillPage({ searchParams }: NewSkillPageProps) {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const mode = parseSkillCreationMode(resolvedSearchParams.mode);

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

  return (
    <main className="skillShell">
      <SkillsTopbar current="new" />
      <header className="skillHeader">
        <div>
          <h1>Create skill drafts</h1>
          <p>
            Upload or paste source material to shape one to three editable drafts,
            or define the skill manually. You will review each draft before activation.
          </p>
        </div>
      </header>
      <div className="skillCreateStack">
        <nav className="skillCreationTabs" aria-label="Skill creation mode">
          <Link
            aria-current={mode === "auto" ? "page" : undefined}
            href="/skills/new"
          >
            Auto draft
          </Link>
          <Link
            aria-current={mode === "manual" ? "page" : undefined}
            href="/skills/new?mode=manual"
          >
            Manual
          </Link>
        </nav>

        {mode === "auto" ? (
          <>
            <section className="skillCreationPath" aria-label="Source-backed skill creation path">
              <div>
                <span>Input</span>
                <strong>Upload or paste source.</strong>
              </div>
              <div>
                <span>Review</span>
                <strong>Edit the drafts.</strong>
              </div>
              <div>
                <span>Activate</span>
                <strong>Prepare verified exercises.</strong>
              </div>
            </section>
            <section className="skillSourceEntryGrid" aria-label="Source-backed draft options">
              <SourceUploadForm />
              <SourceSkillForm />
            </section>
          </>
        ) : (
          <div className="skillManualBody">
            <div className="skillManualIntro">
              <h2 id="manual-skill-title">Write the skill yourself</h2>
            </div>
            <p className="skillManualBodyCopy">
              Use this when you already know the exact skill definition and do not
              need source material interpreted first.
            </p>
            <SkillDraftForm initialValues={emptyDraftValues} mode="create" />
          </div>
        )}
      </div>
    </main>
  );
}

function parseSkillCreationMode(value: string | string[] | undefined): SkillCreationMode {
  const mode = Array.isArray(value) ? value[0] : value;

  return mode === "manual" ? "manual" : "auto";
}
