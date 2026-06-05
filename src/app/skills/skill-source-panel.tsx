import type { SkillSourceSummary } from "@/lib/skills/sources";

import { SkillSourceRemoveForm } from "./skill-source-remove-form";

export function SkillSourcePanel({
  skillId,
  sources,
}: {
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
        <span className="dashboardChip">{formatSourceCount(sources.length)}</span>
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
                <div className="skillMetaLine">
                  <span>{formatSourceKind(source.kind)}</span>
                  <span>{source.status.toLowerCase()}</span>
                  <span>{formatBytes(source.byteSize)}</span>
                  <span>Added {formatDate(source.createdAt)}</span>
                </div>
              </div>
              <SkillSourceRemoveForm skillId={skillId} sourceRefId={source.id} />
            </div>
            {source.note ? <p className="skillSourceNote">{source.note}</p> : null}
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

function formatSourceCount(count: number) {
  return count === 1 ? "1 source" : `${count} sources`;
}

function formatSourceKind(kind: SkillSourceSummary["kind"]) {
  return kind.toLowerCase();
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
