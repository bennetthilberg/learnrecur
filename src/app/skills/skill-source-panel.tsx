import { Badge, Card, DataList } from "@radix-ui/themes";

import { PanelHeaderCount } from "@/components/app/panel-header-count";
import { formatDisplayLabel } from "@/lib/formatters";
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
    <Card asChild className="skillPanel skillSourcePanel" size="3" variant="surface">
      <section aria-labelledby="skill-source-title">
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
              <DataList.Root
                className="skillSourceFacts"
                aria-label={`${source.label} source details`}
                orientation="horizontal"
              >
                <DataList.Item data-priority="primary">
                  <DataList.Label>Status</DataList.Label>
                  <DataList.Value>
                    <Badge color="blue" highContrast variant="surface">
                      {formatSourceStatus(source.status)}
                    </Badge>
                  </DataList.Value>
                </DataList.Item>
                <DataList.Item>
                  <DataList.Label>Type</DataList.Label>
                  <DataList.Value>{formatSourceKind(source.kind)}</DataList.Value>
                </DataList.Item>
                <DataList.Item>
                  <DataList.Label>Size</DataList.Label>
                  <DataList.Value>{formatBytes(source.byteSize)}</DataList.Value>
                </DataList.Item>
                <DataList.Item>
                  <DataList.Label>Added</DataList.Label>
                  <DataList.Value>{formatDate(source.createdAt)}</DataList.Value>
                </DataList.Item>
              </DataList.Root>
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
      </section>
    </Card>
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
