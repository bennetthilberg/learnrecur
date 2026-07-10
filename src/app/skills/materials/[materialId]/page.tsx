import { auth, currentUser } from "@clerk/nextjs/server";
import { ArrowLeft, ArrowSquareOut, FileText, Sparkle } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { CSSProperties } from "react";

import { UserStatusPanel } from "@/components/app/user-status-panel";
import { formatDisplayLabel } from "@/lib/formatters";
import { getMaterialIngestionDisplayState } from "@/lib/materials/ingestion-status";
import { getMaterialDetail } from "@/lib/materials/library";
import { truncateMaterialTitle } from "@/lib/materials/pdf-upload";
import { getMaterialAvailabilityMessage } from "@/lib/materials/presentation";
import { ensureDatabaseUser } from "@/lib/users";

import { SkillsTopbar } from "../../skills-topbar";
import {
  refreshWebsiteMaterialAction,
  retryMaterialIngestionAction,
} from "../actions";
import { MaterialDeleteControl } from "../material-delete-control";
import { MaterialStatusPoller } from "../material-status-poller";
import { MaterialRetryButton } from "../material-retry-button";

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
  const now = new Date();
  const ingestionState = getMaterialIngestionDisplayState({
    status: revision?.status ?? null,
    updatedAt: revision?.updatedAt ?? null,
    now,
  });
  const processing = ingestionState === "processing";
  const stalled = ingestionState === "stalled";
  const displayTitle = truncateMaterialTitle(material.title);
  const availabilityMessage = revision
    ? getMaterialAvailabilityMessage({
        status: revision.status,
        stalled,
        hasReadyRevision: material.activeRevision?.status === "READY",
      })
    : null;
  const pageCount = contentRevision?.pageCount ?? contentRevision?.fetchedPageCount;

  return (
    <main className="skillShell materialShell materialDetailShell">
      <SkillsTopbar current="skills" />
      <MaterialStatusPoller active={processing} />
      <header className="skillHeader materialHeader materialDetailHeader">
        <div>
          <p className="materialBreadcrumb" title={material.title}>
            <Link href="/skills/materials">Materials</Link> / {displayTitle}
          </p>
          <h1 title={material.title}>{displayTitle}</h1>
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

      {availabilityMessage ? (
        <section
          className="materialDetailSummary"
          data-tone={availabilityMessage.tone}
          aria-label="Material availability"
        >
          <div className="materialAvailabilityCopy">
            <span className="materialAvailabilityDot" aria-hidden="true" />
            <div>
              <strong>{availabilityMessage.title}</strong>
              <p>{availabilityMessage.description}</p>
            </div>
          </div>
          {pageCount ? (
            <div className="materialPageCount">
              <span>Pages</span>
              <strong>{pageCount}</strong>
            </div>
          ) : null}
        </section>
      ) : null}

      {stalled ? (
        <section className="skillPanel materialFailurePanel" aria-live="polite">
          <div>
            <h2>Processing hasn’t started</h2>
            <p>Your source is saved, but the background processor did not pick it up. Retry processing without uploading it again.</p>
          </div>
          <form action={retryMaterialIngestionAction}>
            <input name="materialId" type="hidden" value={material.id} />
            <input name="materialRevisionId" type="hidden" value={revision?.id} />
            <MaterialRetryButton>Retry processing</MaterialRetryButton>
          </form>
        </section>
      ) : processing ? (
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
            <MaterialRetryButton>Retry import</MaterialRetryButton>
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
                  <span>
                    {getMaterialIngestionDisplayState({
                      status: item.status,
                      updatedAt: item.updatedAt,
                      now,
                    }) === "stalled"
                      ? "Needs attention"
                      : formatDisplayLabel(item.status)}
                  </span>
                  <small>{new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(item.createdAt)}</small>
                </div>
              ))}
            </div>
          </section>

          <details className="skillPanel materialDangerPanel">
            <summary>Delete material</summary>
            <p>Originals and derived data will be removed. Existing skills stay, but source-backed regeneration stops.</p>
            <div className="materialDangerActions">
              <MaterialDeleteControl
                materialId={material.id}
                returnTo="/skills/materials"
                title={material.title}
              />
            </div>
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
