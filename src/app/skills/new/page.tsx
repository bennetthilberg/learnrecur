import { auth, currentUser } from "@clerk/nextjs/server";
import { Badge, Card, TabNav } from "@radix-ui/themes";
import Link from "next/link";

import { UserStatusPanel } from "@/components/app/user-status-panel";
import { ensureDatabaseUser } from "@/lib/users";

import { SkillDraftForm, type SkillDraftFormValues } from "../skill-draft-form";
import { SourceCreationWorkspace } from "../source-creation-workspace";
import { SkillsTopbar } from "../skills-topbar";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
          <h1>Create a skill</h1>
          <p>
            Upload, paste, or write source material. LearnRecur will create a skill
            for you to review before adding it to practice.
          </p>
        </div>
      </header>
      <div className="skillCreateStack">
        <TabNav.Root className="skillCreationTabs" aria-label="Skill creation mode">
          <TabNav.Link active={mode === "auto"} asChild>
            <Link aria-current={mode === "auto" ? "page" : undefined} href="/skills/new">
              From source
            </Link>
          </TabNav.Link>
          <TabNav.Link active={mode === "manual"} asChild>
            <Link aria-current={mode === "manual" ? "page" : undefined} href="/skills/new?mode=manual">
              Manual
            </Link>
          </TabNav.Link>
        </TabNav.Root>

        {mode === "auto" ? (
          <>
            <Card asChild className="skillCreationPath" size="2" variant="surface">
              <section aria-label="Source-backed skill creation path">
                <div>
                  <Badge color="blue" highContrast variant="surface">
                    Input
                  </Badge>
                  <strong>Add source material.</strong>
                </div>
                <div>
                  <Badge color="blue" highContrast variant="surface">
                    Create
                  </Badge>
                  <strong>Wait while LearnRecur writes the skill.</strong>
                </div>
                <div>
                  <Badge color="blue" highContrast variant="surface">
                    Add
                  </Badge>
                  <strong>Review, edit, then add it to practice.</strong>
                </div>
              </section>
            </Card>
            <SourceCreationWorkspace />
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
