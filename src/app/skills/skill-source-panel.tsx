import { PanelHeaderCount } from "@/components/app/panel-header-count";
import { formatDisplayLabel } from "@/lib/formatters";
import type { SkillSourceSummary } from "@/lib/skills/sources";

import { SkillSourceRemoveForm } from "./skill-source-remove-form";

export function SkillSourcePanel({
  canRemove = true,
  className,
  showEmpty = false,
  skillId,
  sources,
}: {
  canRemove?: boolean;
  className?: string;
  showEmpty?: boolean;
  skillId: string;
  sources: SkillSourceSummary[];
}) {
  if (sources.length === 0 && !showEmpty) {
    return null;
  }

  return (
    <section
      className={["skillPanel skillSourcePanel", className].filter(Boolean).join(" ")}
      aria-labelledby="skill-source-title"
    >
      <div className="skillPanelHeader">
        <div>
          <h2 id="skill-source-title">Linked source material</h2>
        </div>
        <PanelHeaderCount
          ariaLabel="Linked sources shown"
          label="Sources"
          value={formatCount(sources.length)}
        />
      </div>
      {sources.length > 0 ? (
        <div className="skillSourceList">
          {sources.map((source) => (
            <article className="skillSourceRow" key={source.id}>
              <div className="skillSourceRowHeader">
                <div>
                  <h3>{source.label}</h3>
                  {source.note ? <p className="skillSourceNote">{source.note}</p> : null}
                </div>
                {canRemove ? (
                  <SkillSourceRemoveForm
                    skillId={skillId}
                    sourceLabel={source.label}
                    sourceRefId={source.id}
                  />
                ) : null}
              </div>
              <dl className="skillSourceFacts" aria-label={`${source.label} source details`}>
                <div data-priority="primary">
                  <dt>Status</dt>
                  <dd>{formatSourceStatus(source.status)}</dd>
                </div>
                <div>
                  <dt>Type</dt>
                  <dd>{formatSourceKind(source.kind)}</dd>
                </div>
                <div>
                  <dt>Size</dt>
                  <dd>{formatBytes(source.byteSize)}</dd>
                </div>
                <div>
                  <dt>Added</dt>
                  <dd>{formatDate(source.createdAt)}</dd>
                </div>
              </dl>
              {source.preview ? (
                <details className="skillSourcePreviewDetails">
                  <summary>View extracted text preview</summary>
                  <blockquote className="skillSourcePreview">{source.preview}</blockquote>
                </details>
              ) : (
                <p className="skillSourceEmpty">No extracted text preview is available.</p>
              )}
            </article>
          ))}
        </div>
      ) : (
        <p className="skillSourceEmpty">No linked source material for this skill yet.</p>
      )}
    </section>
  );
}

function formatSourceKind(kind: SkillSourceSummary["kind"]) {
  return formatDisplayLabel(kind);
}

function formatCount(count: number) {
  return new Intl.NumberFormat("en-US").format(count);
}

function formatSourceStatus(status: SkillSourceSummary["status"]) {
  return formatDisplayLabel(status);
}

function formatDate(date: Date) {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatBytes(byteSize: number | null) {
  if (byteSize === null) {
    return "Unknown size";
  }

  if (byteSize < 1024) {
    return `${byteSize} B`;
  }

  const kilobytes = byteSize / 1024;

  if (kilobytes < 1024) {
    return `${kilobytes.toFixed(kilobytes >= 10 ? 0 : 1)} KB`;
  }

  const megabytes = kilobytes / 1024;
  return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`;
}
