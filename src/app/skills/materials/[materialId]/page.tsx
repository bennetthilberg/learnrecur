import { auth, currentUser } from "@clerk/nextjs/server";
import { ArrowLeft, ArrowSquareOut, FileText, Sparkle } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";

import { UserStatusPanel } from "@/components/app/user-status-panel";
import { formatDisplayLabel } from "@/lib/formatters";
import { getMaterialDetail, isMaterialProcessing } from "@/lib/materials/library";
import { ensureDatabaseUser } from "@/lib/users";

import { SkillsTopbar } from "../../skills-topbar";
import {
  deleteMaterialAction,
  refreshWebsiteMaterialAction,
  retryMaterialIngestionAction,
} from "../actions";
import { MaterialStatusPoller } from "../material-status-poller";

export const dynamic = "force-dynamic";

export default async function MaterialDetailPage({ params }: { params: Promise<{ materialId: string }> }) {
  const { materialId } = await params;
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
        <UserStatusPanel id="material-setup-title" status={databaseUser} />
      </main>
    );
  }
  const material = await getMaterialDetail({ userId, materialId });
  if (!material) {
    notFound();
  }
  const revision = material.currentRevision;
  const contentRevision = revision?.status === "READY" ? revision : material.activeRevision;
  const processing = isMaterialProcessing(revision?.status ?? null);

  return (
    <main className="skillShell materialShell materialDetailShell">
      <SkillsTopbar current="skills" />
      <MaterialStatusPoller active={processing} />
      <header className="skillHeader materialHeader materialDetailHeader">
        <div>
          <p className="materialBreadcrumb"><Link href="/skills/materials">Materials</Link> / {material.title}</p>
          <h1>{material.title}</h1>
          <p>{material.collection?.name ?? "No collection"} · {formatMaterialKind(material.kind)}</p>
        </div>
        <div className="materialHeaderActions">
          <Link className="secondaryButton" href="/skills/materials">
            <ArrowLeft size={17} weight="bold" aria-hidden="true" /> Library
          </Link>
          {material.activeRevision?.status === "READY" ? (
            <Link className="primaryButton" href={`/skills/materials/${material.id}/create`}>
              <Sparkle size={17} weight="bold" aria-hidden="true" /> Create skills
            </Link>
          ) : null}
          {material.kind === "WEB" && material.activeRevision?.status === "READY" && !processing ? (
            <form action={refreshWebsiteMaterialAction}>
              <input name="materialId" type="hidden" value={material.id} />
              <button className="secondaryButton" type="submit">Refresh site</button>
            </form>
          ) : null}
        </div>
      </header>

      {revision ? (
        <section className="materialDetailSummary" aria-label="Material status">
          <div>
            <span>Status</span>
            <strong>{formatDisplayLabel(revision.status)}</strong>
          </div>
          <div>
            <span>Revision</span>
            <strong>{revision.revisionNumber}</strong>
          </div>
          <div>
            <span>Pages</span>
            <strong>{revision.pageCount ?? revision.fetchedPageCount ?? "—"}</strong>
          </div>
          <div>
            <span>Indexed chunks</span>
            <strong>{revision._count.chunks}</strong>
          </div>
          <div>
            <span>OCR pending</span>
            <strong>{revision._count.pages}</strong>
          </div>
        </section>
      ) : null}

      {processing ? (
        <section className="skillPanel materialProcessingPanel" aria-live="polite">
          <span className="materialProcessingPulse" aria-hidden="true" />
          <div>
            <h2>Building the outline</h2>
            <p>Extracting headings, page references, readable text, and retrieval chunks. This page updates automatically.</p>
          </div>
        </section>
      ) : revision?.status === "FAILED" ? (
        <section className="skillPanel materialFailurePanel">
          <div>
            <h2>Import needs attention</h2>
            <p>{revision.errorMessage ?? "Material processing did not finish."}</p>
          </div>
          <form action={retryMaterialIngestionAction}>
            <input name="materialId" type="hidden" value={material.id} />
            <input name="materialRevisionId" type="hidden" value={revision.id} />
            <button className="secondaryButton" type="submit">Retry import</button>
          </form>
        </section>
      ) : null}

      <div className="materialDetailGrid">
        <section className="skillPanel materialOutlinePanel" aria-labelledby="material-outline-title">
          <div className="skillPanelHeader">
            <div>
              <h2 id="material-outline-title">Outline</h2>
              <p>{contentRevision?.sections.length ?? 0} resolved sections</p>
            </div>
            <FileText size={20} weight="bold" aria-hidden="true" />
          </div>
          {contentRevision?.sections.length ? (
            <ol className="materialOutlineList">
              {contentRevision.sections.map((section) => (
                <li key={section.id} style={{ "--material-section-level": section.level } as CSSProperties}>
                  <span>{section.title}</span>
                  {section.pageStart ? (
                    <small>{formatPageRange(section.pageStart, section.pageEnd)}</small>
                  ) : section.url ? (
                    <a aria-label={`Open source page for ${section.title}`} href={section.url} rel="noreferrer" target="_blank">
                      Source <ArrowSquareOut size={13} weight="bold" aria-hidden="true" />
                    </a>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <div className="materialInlineEmpty"><p>The outline will appear when processing finishes.</p></div>
          )}
        </section>

        <aside className="materialDetailSidebar">
          <section className="skillPanel materialLinkedSkills" aria-labelledby="material-skills-title">
            <div className="skillPanelHeader"><div><h2 id="material-skills-title">Created skills</h2></div></div>
            {contentRevision?.linkedSkills.length ? (
              <div className="materialLinkedSkillList">
                {contentRevision.linkedSkills.map((skill) => (
                  <Link href={`/skills/${skill.id}`} key={skill.id}>
                    <strong>{skill.title}</strong>
                    <small>{formatDisplayLabel(skill.status)}</small>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="materialInlineEmpty"><p>No skills use this revision yet.</p></div>
            )}
          </section>

          <section className="skillPanel materialRevisionPanel" aria-labelledby="material-revisions-title">
            <div className="skillPanelHeader"><div><h2 id="material-revisions-title">Revision history</h2></div></div>
            <div className="materialRevisionList">
              {material.revisions.map((item) => (
                <div key={item.id}>
                  <strong>Revision {item.revisionNumber}</strong>
                  <span>{formatDisplayLabel(item.status)}</span>
                  <small>{new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(item.createdAt)}</small>
                </div>
              ))}
            </div>
          </section>

          <details className="skillPanel materialDangerPanel">
            <summary>Delete material</summary>
            <p>Originals and derived data will be removed. Existing skills stay, but source-backed regeneration stops.</p>
            <form action={deleteMaterialAction}>
              <input name="materialId" type="hidden" value={material.id} />
              <label className="skillField">
                <span>Type “{material.title}” to confirm</span>
                <input name="confirmationTitle" required />
              </label>
              <button className="secondaryButton" type="submit">Queue deletion</button>
            </form>
          </details>
        </aside>
      </div>
    </main>
  );
}

function formatPageRange(start: number, end: number | null) {
  return end && end !== start ? `Pages ${start}–${end}` : `Page ${start}`;
}

function formatMaterialKind(kind: "PDF" | "WEB") {
  return kind === "PDF" ? "PDF" : "Website";
}
