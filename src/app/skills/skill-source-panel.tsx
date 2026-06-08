import { PanelHeaderCount } from "@/components/app/panel-header-count";
import type { SkillSourceSummary } from "@/lib/skills/sources";

import { SkillSourceRemoveForm } from "./skill-source-remove-form";

export function SkillSourcePanel({
  canRemove = true,
  skillId,
  sources,
}: {
  canRemove?: boolean;
  skillId: string;
  sources: SkillSourceSummary[];
}) {
  if (sources.length === 0) {
    return null;
  }

  return (
    <section className="skillPanel skillSourcePanel" aria-labelledby="skill-source-title">
      <div className="skillPanelHeader">
        <div>
          <p className="eyebrow">Source material</p>
          <h2 id="skill-source-title">Stored source context.</h2>
        </div>
        <PanelHeaderCount
          ariaLabel="Linked sources shown"
          label="Sources"
          value={formatCount(sources.length)}
        />
      </div>
      <p className="skillSourceIntro">
        Linked source text helps future exercise generation match this skill. Previews are capped
        here so the page does not expose the full pasted material at a glance.
      </p>
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
              <blockquote className="skillSourcePreview">{source.preview}</blockquote>
            ) : (
              <p className="skillSourceEmpty">No extracted text preview is available.</p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function formatSourceKind(kind: SkillSourceSummary["kind"]) {
  return kind.toLowerCase();
}

function formatCount(count: number) {
  return new Intl.NumberFormat("en-US").format(count);
}

function formatSourceStatus(status: SkillSourceSummary["status"]) {
  return status.toLowerCase();
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
