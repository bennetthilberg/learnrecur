import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";

import { UserStatusPanel } from "@/components/app/user-status-panel";
import { getMaterialLibrary } from "@/lib/materials/library";
import { getPrisma } from "@/lib/prisma";
import { ensureDatabaseUser } from "@/lib/users";

import { MaterialImportWorkspace } from "../../materials/material-import-workspace";
import { MaterialDeletionNotification } from "../../materials/material-deletion-notification";
import { SkillsTopbar } from "../../skills-topbar";

export const dynamic = "force-dynamic";

type NewMultipleSkillsPageProps = {
  searchParams?: Promise<{ deleted?: string | string[] }>;
};

export default async function NewMultipleSkillsPage({ searchParams }: NewMultipleSkillsPageProps) {
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
        <UserStatusPanel id="materials-setup-title" status={databaseUser} />
      </main>
    );
  }

  const [materials, collections] = await Promise.all([
    getMaterialLibrary({ userId }),
    getPrisma().collection.findMany({
      where: { userId, status: "ACTIVE" },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true },
    }),
  ]);
  const params = searchParams ? await searchParams : {};
  const deletedParam = Array.isArray(params.deleted) ? params.deleted[0] : params.deleted;

  return (
    <main className="skillShell materialShell">
      <SkillsTopbar current="new" />
      <header className="skillHeader materialHeader">
        <div>
          <p className="materialBreadcrumb"><Link href="/skills/new">Add</Link> / Multiple skills</p>
          <h1>Create multiple skills</h1>
          <p>Choose a reusable material now. You will describe and confirm the exact scope next.</p>
        </div>
        <Link className="secondaryButton" href="/skills/materials">
          Materials library
        </Link>
      </header>
      <MaterialDeletionNotification active={deletedParam === "1" || deletedParam === "true"} />
      <MaterialImportWorkspace collections={collections} materials={materials} />
    </main>
  );
}
