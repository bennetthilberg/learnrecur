import { auth, currentUser } from "@clerk/nextjs/server";
import { FilePdf, GlobeHemisphereWest, PlusCircle } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

import { UserStatusPanel } from "@/components/app/user-status-panel";
import { formatDisplayLabel } from "@/lib/formatters";
import { getMaterialIngestionDisplayState } from "@/lib/materials/ingestion-status";
import { getMaterialLibrary } from "@/lib/materials/library";
import { ensureDatabaseUser } from "@/lib/users";

import { SkillsTopbar } from "../skills-topbar";
import { MaterialStatusPoller } from "./material-status-poller";

export const dynamic = "force-dynamic";

type MaterialsPageProps = {
  searchParams?: Promise<{ deleted?: string | string[] }>;
};

export default async function MaterialsPage({ searchParams }: MaterialsPageProps) {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();
  if (!clerkUser) {
    throw new Error(`Clerk returned no user for authenticated user ${userId}.`);
  }
  const databaseUser = await ensureDatabaseUser(clerkUser);
  if (databaseUser.status !== "ready") {
    return (
      <main className="skillShell">
        <SkillsTopbar current="skills" />
        <UserStatusPanel id="materials-setup-title" status={databaseUser} />
      </main>
    );
  }
  const materials = await getMaterialLibrary({ userId });
  const now = new Date();
  const hasProcessing = materials.some(
    (material) =>
      getMaterialIngestionDisplayState({
        status: material.revisionStatus,
        updatedAt: material.revisionUpdatedAt,
        now,
      }) === "processing",
  );
  const params = searchParams ? await searchParams : {};

  return (
    <main className="skillShell materialShell">
      <SkillsTopbar current="skills" />
      <MaterialStatusPoller active={hasProcessing} />
      <header className="skillHeader materialHeader">
        <div>
          <p className="materialBreadcrumb"><Link href="/skills">Skills</Link> / Materials</p>
          <h1>Materials</h1>
          <p>Reusable textbooks and references, kept at the exact revision used by each skill.</p>
        </div>
        <Link className="primaryButton" href="/skills/new/multiple">
          <PlusCircle size={18} weight="bold" aria-hidden="true" />
          Add material
        </Link>
      </header>

      {parseBoolean(params.deleted) ? (
        <p className="skillFormMessage" data-tone="saved" role="status">
          Material deletion queued. Linked skills will remain.
        </p>
      ) : null}

      <section className="skillPanel materialLibraryPanel" aria-labelledby="material-library-title">
        <div className="skillPanelHeader materialLibraryHeader">
          <div>
            <h2 id="material-library-title">Your references</h2>
            <p>{materials.length} {materials.length === 1 ? "material" : "materials"}</p>
          </div>
        </div>
        {materials.length > 0 ? (
          <div className="materialLibraryList">
            {materials.map((material) => {
              const Icon = material.kind === "PDF" ? FilePdf : GlobeHemisphereWest;
              const ingestionState = getMaterialIngestionDisplayState({
                status: material.revisionStatus,
                updatedAt: material.revisionUpdatedAt,
                now,
              });
              const stalled = ingestionState === "stalled";
              return (
                <article className="materialLibraryRow" key={material.id}>
                  <span className="materialLibraryIcon" aria-hidden="true">
                    <Icon size={19} weight="bold" />
                  </span>
                  <div className="materialLibraryMain">
                    <Link href={`/skills/materials/${material.id}`}>{material.title}</Link>
                    <p>{material.collectionName ?? "No collection"}</p>
                  </div>
                  <div className="materialLibraryFacts">
                    <span>{material.pageCount ? `${material.pageCount} pages` : "Outline pending"}</span>
                    <span>{material.linkedSkillCount} {material.linkedSkillCount === 1 ? "skill" : "skills"}</span>
                    <span>{material.byteSize ? formatBytes(material.byteSize) : "—"}</span>
                  </div>
                  <div className="materialLibraryStatus">
                    <span
                      className="dashboardChip"
                      data-tone={stalled ? "attention" : material.revisionStatus === "READY" ? "ready" : "neutral"}
                    >
                      {stalled ? "Needs attention" : formatDisplayLabel(material.revisionStatus ?? "PENDING")}
                    </span>
                    <small>Used {formatRelativeDate(material.lastUsedAt ?? material.updatedAt)}</small>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="dashboardEmptyState materialEmptyState">
            <h3>No materials yet</h3>
            <p>Add a long PDF or public textbook site once, then reuse it for future skill batches.</p>
            <Link className="secondaryButton" href="/skills/new/multiple">Add your first material</Link>
          </div>
        )}
      </section>
    </main>
  );
}

function formatBytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function formatRelativeDate(value: Date) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(value);
}

function parseBoolean(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "1" || raw === "true";
}
